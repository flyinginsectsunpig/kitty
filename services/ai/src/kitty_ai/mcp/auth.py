"""Who is calling /mcp. An assistant's token must be meant for Kitty's MCP server (audience kitty-mcp). It is never sent
on to the ledger (the MCP spec forbids token passthrough): the ai service swaps it at Keycloak (RFC 8693 token exchange)
for a short-lived ledger token for the same person, so the ledger still decides what they may see."""

import hashlib
import logging
import threading
import time
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass

import anyio.to_thread
import httpx
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from kitty_ai.auth import TokenVerifier, Unauthorized

log = logging.getLogger(__name__)

TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"
# A cached ledger token is dropped this long before Keycloak says it expires.
EARLY_SECONDS = 30


@dataclass(frozen=True)
class McpCaller:
    sub: str
    ledger_token: str


CURRENT: ContextVar[McpCaller] = ContextVar("kitty_mcp_caller")


class AuthUnavailable(Exception):
    """Keycloak can't be reached, or refuses Kitty's own client: not the person's fault, so not a 401 (which would
    send the assistant round its sign-in again, forever)."""


class LedgerTokenExchanger:
    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret: str,
        http: httpx.Client,
        now: Callable[[], float] = time.monotonic,
    ):
        self._token_url, self._client_id, self._secret = token_url, client_id, client_secret
        self._http, self._now = http, now
        self._cache: dict[str, tuple[str, float]] = {}
        self._lock = threading.Lock()  # tool calls run in worker threads, often several at once

    def exchange(self, subject_token: str) -> str:
        key = hashlib.sha256(subject_token.encode()).hexdigest()
        with self._lock:
            cached = self._cache.get(key)
        if cached and cached[1] > self._now():
            return cached[0]
        try:
            response = self._post(subject_token)
        except httpx.HTTPError as e:
            raise AuthUnavailable(f"Keycloak unreachable: {type(e).__name__}") from e
        if response.status_code == 401:  # invalid_client: Kitty's own secret is wrong
            log.error("Keycloak refused the kitty-mcp client (check AI_MCP_CLIENT_SECRET)")
            raise AuthUnavailable("kitty-mcp client refused")
        if 400 <= response.status_code < 500:
            raise Unauthorized(f"token exchange refused ({response.status_code})")
        if response.status_code >= 300:
            raise AuthUnavailable(f"Keycloak answered {response.status_code}")
        try:
            body = response.json()
            token = body["access_token"]
            lifetime = int(body.get("expires_in", 60))
        except (ValueError, KeyError, TypeError) as e:
            raise AuthUnavailable("Keycloak's exchange answer had no token") from e
        now = self._now()
        with self._lock:
            self._cache = {k: v for k, v in self._cache.items() if v[1] > now}
            self._cache[key] = (token, now + lifetime - EARLY_SECONDS)
        return token

    def _post(self, subject_token: str) -> httpx.Response:
        return self._http.post(
            self._token_url,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "subject_token": subject_token,
                "subject_token_type": TOKEN_TYPE,
                "requested_token_type": TOKEN_TYPE,
                "audience": "kitty-ledger",
                "client_id": self._client_id,
                "client_secret": self._secret,
            },
            timeout=10,
        )


class McpAuth:
    """ASGI middleware in front of the MCP app: 401 with the metadata URL, or the caller set for the request."""

    def __init__(self, app: ASGIApp, verifier: TokenVerifier, exchanger: LedgerTokenExchanger, metadata_url: str):
        self._app, self._verifier, self._exchanger = app, verifier, exchanger
        self._challenge = f'Bearer resource_metadata="{metadata_url}", scope="kitty-mcp"'

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        header = dict(scope.get("headers") or []).get(b"authorization", b"").decode("latin-1")
        try:
            if not header.lower().startswith("bearer "):
                raise Unauthorized("no bearer token")
            token = header[7:].strip()
            caller = await anyio.to_thread.run_sync(self._verifier.verify, token)
            ledger_token = await anyio.to_thread.run_sync(self._exchanger.exchange, token)
        except Unauthorized:
            response = JSONResponse({"code": "unauthorized"}, status_code=401)
            response.headers["WWW-Authenticate"] = self._challenge
            await response(scope, receive, send)
            return
        except (AuthUnavailable, httpx.HTTPError) as e:  # httpx: Keycloak's keys couldn't be fetched
            log.warning("MCP sign-in unavailable: %s", e if isinstance(e, AuthUnavailable) else type(e).__name__)
            await JSONResponse({"code": "ai_unavailable"}, status_code=503)(scope, receive, send)
            return
        reset = CURRENT.set(McpCaller(caller.sub, ledger_token))
        try:
            await self._app(scope, receive, send)
        finally:
            CURRENT.reset(reset)
