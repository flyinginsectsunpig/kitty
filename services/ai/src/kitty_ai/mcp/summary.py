"""The one sentence an assistant gets back with a draft link, so it can tell the person what's waiting for them."""

from kitty_ai.money_text import money_text


def _names(names: list[str]) -> str:
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def of(draft: dict, me_member_id: str, group_name: str) -> str:
    """draft is a card from build_draft; me_member_id is the caller's member in that group ("you")."""
    by_id = {m["id"]: m["displayName"] for m in draft.get("members", [])}

    def who(member_id: str | None, fallback: str = "someone") -> str:
        if member_id == me_member_id:
            return "you"
        return by_id.get(member_id or "", fallback)

    intent = draft["intent"]
    if intent == "expense":
        e = draft["expense"]
        amount = money_text(e["amountMinor"], e["currency"]) if e["amountMinor"] is not None else "no amount yet"
        people = [who(p["memberId"], p["name"]) for p in e["participants"]]
        people = sorted(people, key=lambda n: n != "you")  # "you" first, the rest as named
        how = "equally" if e["split"] == "equal" else "by amounts"
        text = (
            f"Expense in {group_name}: {e['description']}, {amount}, paid by {who(e['payerMemberId'])}, "
            f"split {how} between {_names(people)}. Open the link to check and save it."
        )
    elif intent == "payment":
        p = draft["payment"]
        payer, payee = who(p["fromMemberId"]), who(p["toMemberId"])
        verb = "pay" if payer == "you" else "pays"
        amount = f" {money_text(p['amountMinor'], p['currency'])}" if p["amountMinor"] is not None else ""
        names = {i["expenseId"]: i["description"] for i in p["openItems"]}
        items = [names[c["expenseId"]] for c in p["covers"] if c["expenseId"] in names]
        what = f" for {_names(items)}" if items else ""
        text = f"Payment in {group_name}: {payer} {verb} {payee}{amount}{what}. Open the link to check and save it."
    elif intent == "reminder":
        r = draft["reminder"]
        minor = r["statedAmountMinor"]
        if minor is None:
            minor = r["owedMinorByCurrency"].get(r["statedCurrency"])
        amount = f" {money_text(minor, r['statedCurrency'])}" if minor is not None else ""
        person = who(r["memberId"], r.get("name") or "someone")
        text = f"Reminder in {group_name}: remind {person} to pay you{amount}. Open the link to check and send it."
    else:
        text = f"Draft in {group_name}. Open the link to check it."

    if n := len(draft.get("issues", [])):
        text += f" Kitty needs you to settle {n} thing{'s' if n != 1 else ''} on the card."
    return text
