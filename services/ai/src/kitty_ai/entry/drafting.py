"""One parsed sentence → the draft card for one group, read as the person (their token, through LedgerReader).
Shared by /parse and /resolve, the draft links (/drafts/{id}) and the MCP draft tools."""

from datetime import date

from kitty_ai.entry.resolve import build_draft
from kitty_ai.entry.schema import ParsedSentence
from kitty_ai.ledger import LedgerReader, NotFound


def draft_for(reader: LedgerReader, parsed: ParsedSentence, group_id: str, today: date) -> dict:
    """Raises NotFound when the group doesn't exist or the person isn't one of its members."""
    group = reader.group(group_id)
    me = reader.me()
    me_member = next((m.id for m in group.members if m.user_id == me.id), None)
    if me_member is None:
        raise NotFound(group_id)
    return build_draft(
        parsed,
        group,
        me_member,
        today,
        lambda member: reader.owed_to_me(group.id, me_member, member),
        lambda f, t: reader.open_items(group.id, f, t),
    )
