"""Turns what the model read into a draft the apps can show: groups and people matched to the person's real groups
and members, money in minor units. Pure functions, no I/O. Anything uncertain becomes an issue on the draft for the
person to settle on the confirmation card; nothing is guessed."""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date

from kitty_ai.entry.money import to_minor
from kitty_ai.entry.schema import ParsedSentence
from kitty_ai.ledger import Group, GroupSummary, Member

SPEAKER = {"me", "i", "my", "myself", "mine"}
GROUP_FILLER = {"the", "group", "our", "my", "in", "a"}


def _norm(text: str) -> str:
    return " ".join(text.casefold().split())


@dataclass(frozen=True)
class MemberMatch:
    member_id: str | None
    kind: str  # "ok" | "no_match" | "ambiguous"
    candidates: list[str] = field(default_factory=list)


def match_member(name: str, me_member_id: str, members: list[Member]) -> MemberMatch:
    """Exact display name, then first name, then prefix, case-insensitive. "me"/"I" is the speaker."""
    wanted = _norm(name)
    if wanted in SPEAKER:
        return MemberMatch(me_member_id, "ok")
    rules = (
        lambda m: _norm(m.display_name) == wanted,
        lambda m: _norm(m.display_name).split()[:1] == [wanted],
        lambda m: _norm(m.display_name).startswith(wanted),
    )
    for rule in rules:
        hits = [m.id for m in members if _norm(m.display_name) and rule(m)]
        if len(hits) == 1:
            return MemberMatch(hits[0], "ok")
        if len(hits) > 1:
            return MemberMatch(None, "ambiguous", hits)
    return MemberMatch(None, "no_match")


@dataclass(frozen=True)
class GroupMatch:
    group_id: str | None
    issue: dict | None = None


def _group_words(text: str) -> list[str]:
    return [w for w in _norm(text).split() if w not in GROUP_FILLER]


def match_group(phrase: str | None, page_group_id: str | None, groups: list[GroupSummary]) -> GroupMatch:
    """The group the sentence names (whole words or prefixes of a group's name); else the page's; else the person's
    only group; else an issue asking which."""
    words = _group_words(phrase or "")
    if words:
        hits = []
        for g in groups:
            name = _group_words(g.name)
            if all(any(n.startswith(w) for n in name) for w in words):
                hits.append(g.id)
        if len(hits) == 1:
            return GroupMatch(hits[0])
        kind = "ambiguous" if hits else "no_match"
        return GroupMatch(None, _issue("group", kind, phrase or "", hits))
    if page_group_id and any(g.id == page_group_id for g in groups):
        return GroupMatch(page_group_id)
    if len(groups) == 1:
        return GroupMatch(groups[0].id)
    return GroupMatch(None, _issue("group", "missing", "", [g.id for g in groups]))


def _issue(field_name: str, kind: str, text: str, candidates: list[str] | None = None) -> dict:
    return {"field": field_name, "kind": kind, "text": text, "candidates": candidates or []}


def build_draft(
    parsed: ParsedSentence,
    group: Group,
    me_member_id: str,
    today: date,
    owed_for: Callable[[str], dict[str, int]],
) -> dict:
    """The draft for one group. owed_for(member_id) is what that member owes the speaker (only asked for reminders)."""
    issues: list[dict] = []
    currency = parsed.currency or group.base_currency
    draft: dict = {
        "intent": parsed.intent,
        "groupId": group.id,
        "issues": issues,
        "members": [{"id": m.id, "displayName": m.display_name} for m in group.members],
    }

    def resolve(name: str, field_name: str) -> str | None:
        m = match_member(name, me_member_id, group.members)
        if m.kind != "ok":
            issues.append(_issue(field_name, m.kind, name, m.candidates))
        return m.member_id

    if parsed.intent == "reminder":
        others = [p for p in parsed.people if _norm(p.name) not in SPEAKER]
        member_id = resolve(others[0].name, "reminder.member") if others else None
        if not others:
            issues.append(_issue("reminder.member", "missing", ""))
        stated = parsed.reminder_amount or parsed.amount
        draft["reminder"] = {
            "memberId": member_id,
            "name": others[0].name if others else None,
            "owedMinorByCurrency": owed_for(member_id) if member_id else {},
            "statedAmountMinor": to_minor(stated, currency) if stated else None,
            "statedCurrency": currency,
        }
        return draft

    if parsed.intent != "expense":
        return draft

    payer_id = me_member_id if not parsed.payer or _norm(parsed.payer) in SPEAKER else resolve(parsed.payer, "payer")
    split = parsed.split or ("amounts" if any(p.amount for p in parsed.people) else "equal")

    if not parsed.people:
        participants = [{"memberId": m.id, "name": m.display_name, "amountMinor": None} for m in group.members]
    else:
        participants = [
            {"memberId": resolve(p.name, f"people[{i}]"), "name": p.name, "amountMinor": None}
            for i, p in enumerate(parsed.people)
        ]
        named_others = [p for p in parsed.people if _norm(p.name) not in SPEAKER]
        speaker_named = len(named_others) < len(parsed.people)
        # "Uber R85 with Sam": an equal split the speaker paid, naming one other person, includes the speaker.
        if split == "equal" and not speaker_named and payer_id == me_member_id and len(named_others) < 2:
            participants.insert(0, {"memberId": me_member_id, "name": "me", "amountMinor": None})

    total = to_minor(parsed.amount, currency) if parsed.amount else None
    if split == "amounts":
        amounts = []
        for i, (p, person) in enumerate(zip(participants, parsed.people, strict=False)):
            p["amountMinor"] = to_minor(person.amount, currency) if person.amount else None
            if p["amountMinor"] is None:
                issues.append(_issue(f"people[{i}].amount", "missing", person.amount or ""))
            amounts.append(p["amountMinor"])
        summed = sum(a for a in amounts if a is not None) if all(a is not None for a in amounts) else None
        if total is not None and summed is not None and total != summed:
            issues.append(_issue("amount", "mismatch", parsed.amount or ""))
        total = total if summed is None else summed
    if total is None:
        issues.append(_issue("amount", "missing", parsed.amount or ""))

    draft["expense"] = {
        "description": (parsed.description or "Expense").strip()[:120],
        "category": parsed.category or "other",
        "currency": currency,
        "amountMinor": total,
        "occurredOn": (parsed.date or today).isoformat(),
        "payerMemberId": payer_id,
        "split": split,
        "participants": participants,
    }
    return draft
