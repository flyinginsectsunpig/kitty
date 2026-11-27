"""Drafts an assistant prepared, waiting for the person to open their link and Save or Send in Kitty. A draft belongs
to one person (their Keycloak sub), lasts 24 hours and is deleted once used. Its id is the only thing in the link."""

import secrets
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

import psycopg
from psycopg.types.json import Jsonb

from kitty_ai.entry.schema import ParsedSentence
from kitty_ai.settings import postgres_conninfo

DRAFT_TTL = timedelta(hours=24)


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class Draft:
    id: str
    sub: str
    group_id: str
    parsed: ParsedSentence
    created_at: datetime


class DraftStore(Protocol):
    def save(self, sub: str, group_id: str, parsed: ParsedSentence) -> str: ...
    def get(self, draft_id: str, sub: str) -> Draft | None: ...
    def delete(self, draft_id: str, sub: str) -> None: ...


def _new_id() -> str:
    return secrets.token_urlsafe(16)


class InMemoryDraftStore:
    """For tests, and for a dev stack without Postgres."""

    def __init__(self, now: Callable[[], datetime] = _utcnow):
        self._now = now
        self._drafts: dict[str, Draft] = {}
        self._lock = threading.Lock()

    def save(self, sub: str, group_id: str, parsed: ParsedSentence) -> str:
        draft = Draft(_new_id(), sub, group_id, parsed, self._now())
        with self._lock:
            self._drafts = {k: d for k, d in self._drafts.items() if self._now() - d.created_at <= DRAFT_TTL}
            self._drafts[draft.id] = draft
        return draft.id

    def get(self, draft_id: str, sub: str) -> Draft | None:
        d = self._drafts.get(draft_id)
        if d is None or d.sub != sub or self._now() - d.created_at > DRAFT_TTL:
            return None
        return d

    def delete(self, draft_id: str, sub: str) -> None:
        with self._lock:
            if (d := self._drafts.get(draft_id)) is not None and d.sub == sub:
                del self._drafts[draft_id]


class PostgresDraftStore:
    """ai.mcp_drafts in the shared Postgres (the ai schema, like the receipt worker's tables)."""

    def __init__(self, dsn: str, now: Callable[[], datetime] = _utcnow):
        self._dsn = postgres_conninfo(dsn)
        self._now = now
        self._ready = False
        self._lock = threading.Lock()

    def _connect(self) -> psycopg.Connection:
        conn = psycopg.connect(self._dsn, autocommit=True)
        with self._lock:
            if not self._ready:
                # In production the schema exists, owned by role "ai", which may not create schemas.
                if conn.execute("SELECT 1 FROM pg_namespace WHERE nspname = 'ai'").fetchone() is None:
                    conn.execute("CREATE SCHEMA ai")
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS ai.mcp_drafts (id text PRIMARY KEY, sub text NOT NULL, "
                    "group_id text NOT NULL, parsed jsonb NOT NULL, created_at timestamptz NOT NULL)"
                )
                self._ready = True
        return conn

    def save(self, sub: str, group_id: str, parsed: ParsedSentence) -> str:
        draft_id, now = _new_id(), self._now()
        with self._connect() as conn:
            conn.execute("DELETE FROM ai.mcp_drafts WHERE created_at < %s", (now - DRAFT_TTL,))
            conn.execute(
                "INSERT INTO ai.mcp_drafts (id, sub, group_id, parsed, created_at) VALUES (%s, %s, %s, %s, %s)",
                (draft_id, sub, group_id, Jsonb(parsed.model_dump(mode="json")), now),
            )
        return draft_id

    def get(self, draft_id: str, sub: str) -> Draft | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT group_id, parsed, created_at FROM ai.mcp_drafts "
                "WHERE id = %s AND sub = %s AND created_at >= %s",
                (draft_id, sub, self._now() - DRAFT_TTL),
            ).fetchone()
        if row is None:
            return None
        return Draft(draft_id, sub, row[0], ParsedSentence.model_validate(row[1]), row[2])

    def delete(self, draft_id: str, sub: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM ai.mcp_drafts WHERE id = %s AND sub = %s", (draft_id, sub))
