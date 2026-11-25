"""Checks the Keycloak access token on a request: signed by the realm's key, issued by the realm, meant for this
service (audience), not expired. The token is kept so the ledger can be asked as that person."""

from collections.abc import Callable
from dataclasses import dataclass

import jwt

CLOCK_SKEW_SECONDS = 30


class Unauthorized(Exception):
    """No usable token."""


@dataclass(frozen=True)
class Caller:
    sub: str
    token: str


class TokenVerifier:
    def __init__(self, issuer: str, audience: str, fetch_jwks: Callable[[], dict]):
        self._issuer = issuer
        self._audience = audience
        self._fetch_jwks = fetch_jwks
        self._keys: dict[str, jwt.PyJWK] = {}

    def _key(self, kid: str) -> jwt.PyJWK:
        if kid not in self._keys:  # first use, or the realm rotated its key: fetch once more
            self._keys = {k.key_id: k for k in jwt.PyJWKSet.from_dict(self._fetch_jwks()).keys if k.key_id}
        if kid not in self._keys:
            raise Unauthorized("unknown signing key")
        return self._keys[kid]

    def verify(self, token: str) -> Caller:
        try:
            kid = jwt.get_unverified_header(token).get("kid") or ""
            claims = jwt.decode(
                token,
                self._key(kid),
                algorithms=["RS256"],
                audience=self._audience,
                issuer=self._issuer,
                leeway=CLOCK_SKEW_SECONDS,
                options={"require": ["exp", "iss", "aud", "sub"]},
            )
        except jwt.PyJWTError as e:
            raise Unauthorized(str(e)) from e
        return Caller(sub=claims["sub"], token=token)


def jwks_fetcher(issuer: str, client) -> Callable[[], dict]:
    """The realm's public keys, from Keycloak's certs endpoint."""

    def fetch() -> dict:
        response = client.get(f"{issuer.rstrip('/')}/protocol/openid-connect/certs", timeout=10)
        response.raise_for_status()
        return response.json()

    return fetch
