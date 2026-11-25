"""POST /parse and POST /resolve: one sentence → a draft, for the signed-in person. Nothing here writes to the ledger;
the apps save or send only when the person taps Save or Send. The sentence is never logged."""

import logging
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError

from kitty_ai.auth import TokenVerifier, Unauthorized
from kitty_ai.entry.parse import Parser
from kitty_ai.entry.resolve import build_draft, match_group
from kitty_ai.entry.schema import ParsedSentence
from kitty_ai.ledger import LedgerReader, NotFound
from kitty_ai.limits import RateLimiter
from kitty_ai.receipts.extract import ModelUnavailable, RateLimited, UnusableOutput
from kitty_ai.settings import Settings

log = logging.getLogger(__name__)

SOUTH_AFRICA = timezone(timedelta(hours=2))  # no daylight saving, so a fixed offset is exact
MAX_TEXT = 500


def south_african_today() -> date:
    return datetime.now(SOUTH_AFRICA).date()


class ParseBody(BaseModel):
    text: str = ""
    groupId: str | None = None


class ResolveBody(BaseModel):
    parsed: dict
    groupId: str


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"code": code}, status_code=status)


def make_router(
    settings: Settings,
    verifier: TokenVerifier,
    parser: Parser,
    http_client: httpx.Client,
    today: Callable[[], date] = south_african_today,
) -> APIRouter:
    router = APIRouter()
    parse_limit = RateLimiter(30, 3600)
    resolve_limit = RateLimiter(120, 3600)

    def caller_of(request: Request):
        header = request.headers.get("authorization", "")
        if not header.lower().startswith("bearer "):
            raise Unauthorized("no bearer token")
        return verifier.verify(header[7:].strip())

    def draft_for(reader: LedgerReader, parsed: ParsedSentence, group_id: str) -> dict:
        group = reader.group(group_id)
        me = reader.me()
        me_member = next((m.id for m in group.members if m.user_id == me.id), None)
        if me_member is None:
            raise NotFound(group_id)
        return build_draft(
            parsed, group, me_member, today(), lambda member: reader.owed_to_me(group.id, me_member, member)
        )

    def respond(draft: dict, parsed: ParsedSentence, groups) -> JSONResponse:
        draft["groups"] = [{"id": g.id, "name": g.name} for g in groups]
        draft["parsed"] = parsed.model_dump(mode="json")
        return JSONResponse(draft)

    @router.post("/parse")
    def parse(body: ParseBody, request: Request) -> JSONResponse:
        try:
            return _parse(body, request)
        except httpx.HTTPError:
            return _error(503, "ai_unavailable")  # the ledger couldn't be reached

    def _parse(body: ParseBody, request: Request) -> JSONResponse:
        started = time.monotonic()
        try:
            caller = caller_of(request)
        except Unauthorized:
            return _error(401, "unauthorized")
        text = body.text.strip()
        if not 1 <= len(text) <= MAX_TEXT:
            return _error(400, "validation_failed")
        if not parse_limit.allow(caller.sub):
            return _error(429, "rate_limited")
        reader = LedgerReader(settings.ledger_url, caller.token, http_client)
        groups = reader.groups()
        page = next((g for g in groups if g.id == body.groupId), None)
        only = groups[0] if len(groups) == 1 else None
        # The model fills in this currency only when the sentence names none; ZAR (Kitty's home currency) when the
        # person has several groups and isn't on one.
        default_currency = (page or only).base_currency if (page or only) else "ZAR"
        try:
            parsed = parser.parse(text, today(), default_currency)
        except (ModelUnavailable, RateLimited):
            return _error(503, "ai_unavailable")
        except UnusableOutput:
            return _error(422, "unclear")
        match = match_group(parsed.group, body.groupId, groups)
        try:
            if match.group_id is None:
                draft = {"intent": parsed.intent, "groupId": None, "issues": [match.issue], "members": []}
            else:
                draft = draft_for(reader, parsed, match.group_id)
        except NotFound:
            return _error(404, "not_found")
        log.info(
            "parsed a sentence: intent=%s sub=%s ms=%d", parsed.intent, caller.sub, (time.monotonic() - started) * 1000
        )
        return respond(draft, parsed, groups)

    @router.post("/resolve")
    def resolve(body: ResolveBody, request: Request) -> JSONResponse:
        try:
            return _resolve(body, request)
        except httpx.HTTPError:
            return _error(503, "ai_unavailable")

    def _resolve(body: ResolveBody, request: Request) -> JSONResponse:
        try:
            caller = caller_of(request)
        except Unauthorized:
            return _error(401, "unauthorized")
        if not resolve_limit.allow(caller.sub):
            return _error(429, "rate_limited")
        try:
            parsed = ParsedSentence.model_validate(body.parsed)
        except ValidationError:
            return _error(400, "validation_failed")
        reader = LedgerReader(settings.ledger_url, caller.token, http_client)
        groups = reader.groups()
        if not any(g.id == body.groupId for g in groups):
            return _error(404, "not_found")
        try:
            draft = draft_for(reader, parsed, body.groupId)
        except NotFound:
            return _error(404, "not_found")
        return respond(draft, parsed, groups)

    return router
