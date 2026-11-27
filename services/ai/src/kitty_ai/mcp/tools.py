"""What Kitty's MCP tools do, as plain functions (the SDK wiring is in server.py). Every lookup runs as the person,
through a LedgerReader holding their exchanged ledger token. Nothing here writes to the ledger: drafts are stored for
the person to open from a link and Save or Send in Kitty.

Errors are results the assistant can read and act on ({"error": ...}), never exceptions."""

import logging
from datetime import date

import httpx
from pydantic import ValidationError

from kitty_ai.ask.tools import CATEGORIES, MAX_TEXT, iso_date
from kitty_ai.entry.drafting import draft_for
from kitty_ai.entry.resolve import match_group, match_member
from kitty_ai.entry.schema import ParsedSentence
from kitty_ai.ledger import GroupSummary, LedgerReader, NotFound
from kitty_ai.mcp import summary
from kitty_ai.mcp.drafts import DraftStore

PAGE = 20
# What one draft may hold: an assistant can send anything, and the draft is stored. 120 is the card's own description
# length; 20 people and 10 items are more than any real expense or payment.
MAX_DESCRIPTION, MAX_PEOPLE, MAX_ITEMS = 120, 20, 10
log = logging.getLogger(__name__)


class BadArguments(Exception):
    def __init__(self, field: str, extra: dict | None = None):
        super().__init__(field)
        self.field, self.extra = field, extra or {}


def _bad(field: str, **extra) -> dict:
    return {"error": "bad_arguments", "detail": field} | extra


def _group_list(groups: list[GroupSummary]) -> list[dict]:
    return [{"id": g.id, "name": g.name} for g in groups]


def _group(reader: LedgerReader, value) -> GroupSummary:
    """One of the person's groups, by id or by name (whole words or prefixes, as 4a matches them)."""
    groups = reader.groups()
    if isinstance(value, str) and value.strip():
        if exact := next((g for g in groups if g.id == value), None):
            return exact
        match = match_group(value, None, groups)
        if match.group_id is not None:
            return next(g for g in groups if g.id == match.group_id)
    raise BadArguments("group", {"groups": _group_list(groups)})


def _text(args: dict, key: str) -> str | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > MAX_TEXT:
        raise BadArguments(key)
    return value.strip() or None


def _dates(args: dict) -> tuple[str | None, str | None]:
    out = []
    for key in ("from", "to"):
        try:
            out.append(iso_date(args.get(key)))
        except ValueError:
            raise BadArguments(key) from None
    if out[0] and out[1] and out[0] > out[1]:
        raise BadArguments("from")
    return out[0], out[1]


def _category(args: dict) -> str | None:
    category = args.get("category")
    if category is not None and category not in CATEGORIES:
        raise BadArguments("category")
    return category


def _guarded(work) -> dict:
    try:
        return work()
    except BadArguments as e:
        return _bad(e.field, **e.extra)
    except NotFound:
        return {"error": "not_found"}
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 400:
            return {"error": "bad_arguments"}
        # Never the exception text: its URL carries the person's search text and ids.
        log.warning("ledger answered %d to an MCP tool", e.response.status_code)
        return {"error": "unavailable"}
    except httpx.HTTPError as e:
        log.warning("ledger unreachable from an MCP tool: %s", type(e).__name__)
        return {"error": "unavailable"}


def list_groups(reader: LedgerReader, args: dict) -> dict:
    def work():
        out = []
        for g in reader.groups():
            members = reader.group(g.id).members
            out.append(
                {
                    "id": g.id,
                    "name": g.name,
                    "currency": g.base_currency,
                    "members": [{"name": m.display_name, "hasAccount": m.user_id is not None} for m in members],
                }
            )
        return {"groups": out}

    return _guarded(work)


def get_balances(reader: LedgerReader, args: dict) -> dict:
    def work():
        if args.get("group") is None:
            return reader.owing()
        g = _group(reader, args["group"])
        return {"group": {"id": g.id, "name": g.name}, "balances": reader.balances(g.id)}

    return _guarded(work)


def group_spending(reader: LedgerReader, args: dict) -> dict:
    def work():
        g = _group(reader, args.get("group"))
        from_, to = _dates(args)
        return reader.spending(g.id, from_, to, _category(args), _text(args, "text"))

    return _guarded(work)


def list_expenses(reader: LedgerReader, args: dict) -> dict:
    def work():
        g = _group(reader, args.get("group"))
        from_, to = _dates(args)
        category, text = _category(args), _text(args, "text")
        member = None
        if (person := _text(args, "person")) is not None:
            group, me = reader.group(g.id), reader.me()
            me_member = next((m.id for m in group.members if m.user_id == me.id), "")
            found = match_member(person, me_member, group.members)
            if found.kind != "ok":
                raise BadArguments("person")
            member = found.member_id
        cursor = _text(args, "cursor")
        return reader.expense_lines(g.id, from_, to, category, text, member, cursor, PAGE)

    return _guarded(work)


def _amount(value) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise BadArguments("amount")
    return str(value)


def _check_sizes(args: dict) -> None:
    for key in ("payer", "counterpart", "person", "for", "currency", "date", "category", "split", "direction"):
        if isinstance(args.get(key), str) and len(args[key]) > MAX_TEXT:
            raise BadArguments(key)
    if isinstance(args.get("description"), str) and len(args["description"]) > MAX_DESCRIPTION:
        raise BadArguments("description")
    for key, limit in (("people", MAX_PEOPLE), ("items", MAX_ITEMS)):
        if isinstance(args.get(key), list) and len(args[key]) > limit:
            raise BadArguments(key)
    for i, p in enumerate(args.get("people") or []):
        if isinstance(p, dict) and isinstance(p.get("name"), str) and len(p["name"]) > MAX_TEXT:
            raise BadArguments(f"people[{i}].name")
    for i, item in enumerate(args.get("items") or []):
        if isinstance(item, str) and len(item) > MAX_TEXT:
            raise BadArguments(f"items[{i}]")


def _parsed(intent: str, args: dict) -> ParsedSentence:
    _check_sizes(args)
    if intent == "expense":
        people = args.get("people") or []
        if not isinstance(people, list) or not all(isinstance(p, dict) for p in people):
            raise BadArguments("people")
        body = {
            "intent": "expense",
            "description": args.get("description"),
            "category": args.get("category"),
            "currency": args.get("currency"),
            "amount": _amount(args.get("amount")),
            "date": args.get("date"),
            "payer": args.get("payer"),
            "people": [{"name": p.get("name"), "amount": _amount(p.get("amount"))} for p in people],
            "split": args.get("split"),
        }
    elif intent == "payment":
        body = {
            "intent": "payment",
            "direction": args.get("direction"),
            "counterpart": args.get("counterpart"),
            "items": args.get("items") or [],
            "amount": _amount(args.get("amount")),
            "currency": args.get("currency"),
            "date": args.get("date"),
        }
    elif intent == "reminder":
        person = args.get("person")
        body = {
            "intent": "reminder",
            "people": [{"name": person}] if person else [],
            "description": args.get("for"),
            "reminder_amount": _amount(args.get("amount")),
        }
    else:
        raise BadArguments("intent")
    try:
        return ParsedSentence.model_validate({k: v for k, v in body.items() if v is not None})
    except ValidationError as e:
        loc = e.errors()[0]["loc"]
        raise BadArguments(str(loc[0]) if loc else "arguments") from None


def draft(
    reader: LedgerReader, store: DraftStore, sub: str, web_url: str, intent: str, args: dict, today: date
) -> dict:
    """Stores a draft and returns its link, whenever the group is known; issues go back beside the link, for the card
    to settle. Only an unknown or ambiguous group means no draft: the person's groups come back instead."""

    def work():
        parsed = _parsed(intent, args)
        groups = reader.groups()
        wanted = args.get("group")
        group = next((g for g in groups if g.id == wanted), None)
        if group is None:
            match = match_group(wanted if isinstance(wanted, str) else None, None, groups)
            if match.group_id is None:
                return {"link": None, "issues": [match.issue], "groups": _group_list(groups)}
            group = next(g for g in groups if g.id == match.group_id)
        card = draft_for(reader, parsed, group.id, today)
        members, me = reader.group(group.id).members, reader.me()
        me_member = next((m.id for m in members if m.user_id == me.id), "")
        draft_id = store.save(sub, group.id, parsed)
        return {
            "summary": summary.of(card, me_member, group.name),
            "link": f"{web_url.rstrip('/')}/d/{draft_id}",
            "issues": card["issues"],
        }

    return _guarded(work)
