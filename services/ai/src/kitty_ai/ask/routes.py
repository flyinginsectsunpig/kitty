"""POST /ask: a question about your own money, answered from read-only lookups run as you. The server keeps nothing: the
app sends the conversation each time. Logs say which lookups ran, how many model calls and how long; never the question,
the conversation, the lookup results or the answer."""

import logging
import time
from collections.abc import Callable
from datetime import date
from typing import Literal

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError

from kitty_ai.ask.agent import Answer, ChatModel, Message, run_agent, system_prompt
from kitty_ai.ask.tools import run_tool
from kitty_ai.auth import TokenVerifier, Unauthorized
from kitty_ai.entry.routes import south_african_today
from kitty_ai.ledger import LedgerReader
from kitty_ai.limits import RateLimiter
from kitty_ai.receipts.extract import ModelUnavailable, RateLimited, UnusableOutput
from kitty_ai.settings import Settings
from kitty_ai.telemetry import model_call

log = logging.getLogger(__name__)

MAX_MESSAGES = 12
MAX_PERSON_TEXT = 500
MAX_KITTY_TEXT = 4000
QUESTIONS_PER_HOUR = 15


class AskMessage(BaseModel):
    role: Literal["person", "kitty"]
    text: str


class AskBody(BaseModel):
    messages: list[AskMessage]
    groupId: str | None = None


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"code": code}, status_code=status)


def _conversation(raw: dict) -> tuple[list[Message], str | None] | None:
    """The validated conversation and group id, or None when the body breaks the limits."""
    try:
        body = AskBody.model_validate(raw)
    except ValidationError:
        return None
    messages = [Message(m.role, m.text.strip() if m.role == "person" else m.text) for m in body.messages]
    if not 1 <= len(messages) <= MAX_MESSAGES or messages[-1].role != "person":
        return None
    for m in messages:
        if m.role == "person" and not 1 <= len(m.text) <= MAX_PERSON_TEXT:
            return None
        if m.role == "kitty" and len(m.text) > MAX_KITTY_TEXT:
            return None
    return messages, body.groupId


def make_ask_router(
    settings: Settings,
    verifier: TokenVerifier,
    chat: ChatModel,
    http_client: httpx.Client,
    today: Callable[[], date] = south_african_today,
) -> APIRouter:
    router = APIRouter()
    ask_limit = RateLimiter(QUESTIONS_PER_HOUR, 3600)

    @router.post("/ask")
    def ask(body: dict, request: Request) -> JSONResponse:
        try:
            return _ask(body, request)
        except httpx.HTTPError:
            return _error(503, "ai_unavailable")  # the ledger couldn't be reached

    def _ask(raw: dict, request: Request) -> JSONResponse:
        started = time.monotonic()
        header = request.headers.get("authorization", "")
        try:
            if not header.lower().startswith("bearer "):
                raise Unauthorized("no bearer token")
            caller = verifier.verify(header[7:].strip())
        except Unauthorized:
            return _error(401, "unauthorized")
        valid = _conversation(raw)
        if valid is None:
            return _error(400, "validation_failed")
        conversation, group_id = valid
        if not ask_limit.allow(caller.sub):
            return _error(429, "rate_limited")

        reader = LedgerReader(settings.ledger_url, caller.token, http_client)
        me = reader.me()
        group = next((g for g in reader.groups() if g.id == group_id), None)
        try:
            prompt = system_prompt(today(), me.display_name, group)
            with model_call("ask"):  # one question, however many model turns it takes
                outcome, lookups, calls = run_agent(chat, prompt, conversation, lambda n, a: run_tool(reader, n, a))
        except (ModelUnavailable, RateLimited) as e:
            log.warning("model unavailable: %s status=%s", type(e).__name__, getattr(e.__cause__, "code", None))
            return _error(503, "ai_unavailable")
        except UnusableOutput:
            log.warning("model gave no usable answer")
            return _error(422, "unclear")

        log.info(
            "answered: outcome=%s lookups=%s model_calls=%d sub=%s ms=%d",
            "answer" if isinstance(outcome, Answer) else "entry",
            ",".join(lookups) or "-",
            calls,
            caller.sub,
            (time.monotonic() - started) * 1000,
        )
        if isinstance(outcome, Answer):
            return JSONResponse({"answer": outcome.text})
        return JSONResponse({"kind": "entry"})

    return router
