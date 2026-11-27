"""GET and DELETE /drafts/{id}: the apps open an assistant's draft from its link and finish it after Save or Send.
Called with the person's own app token (audience kitty-ai). Only the person the draft was made for can open it."""

from collections.abc import Callable
from datetime import date

import httpx
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from kitty_ai.auth import TokenVerifier, Unauthorized
from kitty_ai.entry.drafting import draft_for
from kitty_ai.entry.routes import south_african_today
from kitty_ai.ledger import LedgerReader, NotFound
from kitty_ai.mcp.drafts import DraftStore
from kitty_ai.settings import Settings


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"code": code}, status_code=status)


def make_draft_router(
    settings: Settings,
    verifier: TokenVerifier,
    store: DraftStore,
    http_client: httpx.Client,
    today: Callable[[], date] = south_african_today,
) -> APIRouter:
    router = APIRouter()

    def caller_of(request: Request):
        header = request.headers.get("authorization", "")
        if not header.lower().startswith("bearer "):
            raise Unauthorized("no bearer token")
        return verifier.verify(header[7:].strip())

    @router.get("/drafts/{draft_id}")
    def get_draft(draft_id: str, request: Request) -> JSONResponse:
        try:
            caller = caller_of(request)
        except Unauthorized:
            return _error(401, "unauthorized")
        draft = store.get(draft_id, caller.sub)
        if draft is None:
            return _error(404, "not_found")
        reader = LedgerReader(settings.ledger_url, caller.token, http_client)
        try:
            groups = reader.groups()
            # Resolved afresh: balances and open items may have moved since the assistant made it.
            card = draft_for(reader, draft.parsed, draft.group_id, today())
        except NotFound:
            return _error(404, "not_found")
        except httpx.HTTPError:
            return _error(503, "ai_unavailable")
        card["groups"] = [{"id": g.id, "name": g.name} for g in groups]
        card["parsed"] = draft.parsed.model_dump(mode="json")
        return JSONResponse(card)

    @router.delete("/drafts/{draft_id}")
    def delete_draft(draft_id: str, request: Request) -> Response:
        try:
            caller = caller_of(request)
        except Unauthorized:
            return _error(401, "unauthorized")
        store.delete(draft_id, caller.sub)
        return Response(status_code=204)

    return router
