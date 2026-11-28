"""Turns what the model read into a draft the apps can show: groups and people matched to the person's real groups
and members, money in minor units. Pure functions, no I/O. Anything uncertain becomes an issue on the draft for the
person to settle on the confirmation card; nothing is guessed."""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date

from kitty_ai.currencies import exponent
from kitty_ai.entry.money import to_minor
from kitty_ai.entry.schema import ParsedSentence, Person
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


def _phrase_matches(phrase: str, description: str) -> bool:
    """Every word of the phrase starts some word of the description: "groc wool" matches "Woolworths groceries"."""
    words = _norm(description).split()
    return all(any(w.startswith(p) for w in words) for p in _norm(phrase).split())


def _payment(
    parsed: ParsedSentence,
    group: Group,
    me_member_id: str,
    currency: str,
    issues: list[dict],
    open_items: Callable[[str, str], dict],
) -> dict:
    """The payment the sentence describes, crossing off the open items it names (all of them when it names none)."""
    other_id = None
    if not parsed.counterpart:
        issues.append(_issue("payment.counterpart", "missing", ""))
    else:
        m = match_member(parsed.counterpart, me_member_id, group.members)
        if m.kind == "ok" and m.member_id == me_member_id:  # paying yourself isn't a payment
            issues.append(_issue("payment.counterpart", "no_match", parsed.counterpart))
        elif m.kind != "ok":
            issues.append(_issue("payment.counterpart", m.kind, parsed.counterpart, m.candidates))
        else:
            other_id = m.member_id
    # Crossing something off means the speaker paid, unless the sentence says they did.
    from_id, to_id = (other_id, me_member_id) if parsed.direction == "they_paid" else (me_member_id, other_id)

    base = group.base_currency
    if currency != base:
        issues.append(_issue("payment.amount", "other_currency", parsed.currency or ""))
    stated = to_minor(parsed.amount, currency) if parsed.amount else None
    unreadable = bool(parsed.amount) and stated is None  # never read as "pay everything open"
    if unreadable:
        issues.append(_issue("payment.amount", "missing", parsed.amount or ""))

    owed: list[dict] = []
    if other_id is not None:
        owed = [o for c in open_items(from_id, to_id)["currencies"] for o in c["fromOwes"]]
    in_base = sorted(
        (o for o in owed if o["open"]["currency"] == base), key=lambda o: (o["item"]["date"], o["item"]["expenseId"])
    )
    elsewhere = [o for o in owed if o["open"]["currency"] != base]
    open_list = [
        {
            "expenseId": o["item"]["expenseId"],
            "description": o["item"]["description"],
            "date": o["item"]["date"],
            "openMinor": o["open"]["minor"],
        }
        for o in in_base
    ]
    if other_id is not None and not open_list:
        issues.append(_issue("payment.items", "missing", ""))

    covered = {i["expenseId"] for i in open_list} if not any(p.strip() for p in parsed.items) else set()
    for n, phrase in enumerate(parsed.items):
        if not phrase.strip():
            continue
        hits = [i["expenseId"] for i in open_list if _phrase_matches(phrase, i["description"])]
        if len(hits) == 1:
            covered.add(hits[0])
        elif hits:
            issues.append(_issue(f"payment.items[{n}]", "ambiguous", phrase, hits))
        elif any(_phrase_matches(phrase, o["item"]["description"]) for o in elsewhere):
            issues.append(_issue(f"payment.items[{n}]", "other_currency", phrase))
        elif open_list:
            issues.append(_issue(f"payment.items[{n}]", "no_match", phrase, [i["expenseId"] for i in open_list]))

    # Oldest first. A stated amount of the group's currency is spread over the covered items, each up to what's open
    # on it, and any rest stays not tied to an item; without one, each covered item is paid in full.
    left = stated if currency == base else None
    covers: list[dict] = []
    for i in open_list:
        if i["expenseId"] not in covered:
            continue
        amount = i["openMinor"] if left is None else min(i["openMinor"], left)
        if amount > 0:
            covers.append({"expenseId": i["expenseId"], "amountMinor": amount})
        if left is not None:
            left -= amount
    if unreadable:
        total = None
    elif currency == base and stated is not None:
        total = stated
    else:
        total = sum(c["amountMinor"] for c in covers) or None
    return {
        "fromMemberId": from_id,
        "toMemberId": to_id,
        "currency": base,
        "amountMinor": total,
        "statedAmountMinor": stated,
        "openItems": open_list,
        "covers": covers,
    }


def build_draft(
    parsed: ParsedSentence,
    group: Group,
    me_member_id: str,
    today: date,
    owed_for: Callable[[str], dict[str, int]],
    open_items: Callable[[str, str], dict],
) -> dict:
    """The draft for one group. owed_for(member_id) is what that member owes the speaker (only asked for reminders);
    open_items(from_member, to_member) is the ledger's open items between two members (only asked for payments)."""
    if parsed.intent == "question":  # the app sends it on to /ask: nothing to fill in
        return {"intent": "question", "groupId": group.id, "issues": [], "members": []}
    issues: list[dict] = []
    currency = (parsed.currency or group.base_currency).strip().upper()
    try:
        exponent(currency)
    except ValueError:
        issues.append(_issue("currency", "missing", parsed.currency or ""))
        currency = group.base_currency  # so the form can still open; Save waits for the person
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
        if not others and parsed.counterpart and _norm(parsed.counterpart) not in SPEAKER:
            # The model sometimes names the person as the counterpart (the payment field) instead of in people.
            others = [Person(name=parsed.counterpart)]
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

    if parsed.intent == "payment":
        draft["payment"] = _payment(parsed, group, me_member_id, currency, issues, open_items)
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
        # "Uber R85 with Sam": a split the model called equal, paid by the speaker, naming one other person, includes
        # the speaker. Only when "equal" was the model's answer: a one-person debt it left unsplit stays whole. The
        # speaker goes last, so the issues (numbered by the people named) still point at their rows.
        explicit_equal = parsed.split == "equal"
        if explicit_equal and not speaker_named and payer_id == me_member_id and len(named_others) < 2:
            participants.append({"memberId": me_member_id, "name": "me", "amountMinor": None})

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

    occurred = today
    if parsed.date:
        try:
            occurred = date.fromisoformat(parsed.date)
        except ValueError:
            issues.append(_issue("date", "missing", parsed.date))

    draft["expense"] = {
        "description": (parsed.description or "Expense").strip()[:120],
        "category": parsed.category or "other",
        "currency": currency,
        "amountMinor": total,
        "occurredOn": occurred.isoformat(),
        "payerMemberId": payer_id,
        "split": split,
        "participants": participants,
    }
    return draft
