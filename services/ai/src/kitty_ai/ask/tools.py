"""The lookups the agent may use. All read-only, all run as the person (their token, through LedgerReader).

Errors are results the model can read ({"error": ...}), never crashes, except NotAQuestion (the route answers "entry")
and a ledger that's down (httpx.HTTPError, which the route turns into 503).
"""

import re
from dataclasses import dataclass
from datetime import date
from typing import get_args

import httpx

from kitty_ai.entry.schema import Category
from kitty_ai.ledger import LedgerReader, NotFound

CATEGORIES: tuple[str, ...] = get_args(Category)
MAX_TEXT = 100
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class NotAQuestion(Exception):
    """The latest message is something to add or a reminder, not a question."""


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict  # JSON Schema


_NO_PARAMETERS = {"type": "object", "properties": {}}

TOOLS: list[ToolSpec] = [
    ToolSpec(
        "list_groups",
        "The person's groups: id, name, currency and when each was created.",
        _NO_PARAMETERS,
    ),
    ToolSpec(
        "what_i_owe",
        "What the person owes and is owed across all their groups: grand totals per currency, per person, "
        "and per group with the settle-up plan, the items still open (with what's left and who it's open with), "
        "and the payments since they were last square with each one's part not tied to an item. "
        "Amounts are already formatted.",
        _NO_PARAMETERS,
    ),
    ToolSpec(
        "group_spending",
        "One group's spending between two dates (inclusive), optionally one category or a description containing some "
        "text: totals, the person's share, by category, by who paid, the five biggest and the five latest expenses.",
        {
            "type": "object",
            "properties": {
                "group_id": {"type": "string", "description": "The group's id, from list_groups."},
                "from": {"type": "string", "description": "First day, YYYY-MM-DD."},
                "to": {"type": "string", "description": "Last day, YYYY-MM-DD."},
                "category": {"type": "string", "enum": list(CATEGORIES)},
                "text": {"type": "string", "description": "Text the description contains, e.g. uber."},
            },
            "required": ["group_id"],
        },
    ),
    ToolSpec(
        "not_a_question",
        "Call this when the latest message is something to add or a reminder to send, not a question: a new "
        "expense, a payment that happened, or crossing off an existing expense as paid.",
        _NO_PARAMETERS,
    ),
]


def iso_date(value) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not _ISO_DATE.match(value):
        raise ValueError(value)
    date.fromisoformat(value)  # raises on 2026-13-01
    return value


def _spending_args(args: dict) -> tuple[str, str | None, str | None, str | None, str | None]:
    if set(args) - {"group_id", "from", "to", "category", "text"}:
        raise ValueError("unknown argument")
    group_id = args.get("group_id")
    if not isinstance(group_id, str) or not group_id:
        raise ValueError("group_id")
    from_, to = iso_date(args.get("from")), iso_date(args.get("to"))
    if from_ and to and from_ > to:
        raise ValueError("from after to")
    category = args.get("category")
    if category is not None and category not in CATEGORIES:
        raise ValueError("category")
    text = args.get("text")
    if text is not None and (not isinstance(text, str) or len(text) > MAX_TEXT):
        raise ValueError("text")
    return group_id, from_, to, category, text or None


def run_tool(reader: LedgerReader, name: str, args: dict) -> dict:
    try:
        match name:
            case "list_groups":
                return {
                    "groups": [
                        {"id": g.id, "name": g.name, "currency": g.base_currency, "createdAt": g.created_at}
                        for g in reader.groups()
                    ]
                }
            case "what_i_owe":
                return reader.owing()
            case "group_spending":
                try:
                    group_id, from_, to, category, text = _spending_args(args)
                except ValueError:
                    return {"error": "bad_arguments"}
                return reader.spending(group_id, from_, to, category, text)
            case "not_a_question":
                raise NotAQuestion()
            case _:
                return {"error": "unknown_tool"}
    except NotFound:
        return {"error": "not_found"}
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 400:
            return {"error": "bad_arguments"}
        raise
