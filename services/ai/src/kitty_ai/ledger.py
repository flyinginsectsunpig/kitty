"""Reads the ledger as the person asking (their own token), so the ledger decides what they may see."""

from dataclasses import dataclass

import httpx


class NotFound(Exception):
    """No such thing, or the person can't see it."""


@dataclass(frozen=True)
class Me:
    id: str
    display_name: str


@dataclass(frozen=True)
class GroupSummary:
    id: str
    name: str
    base_currency: str
    created_at: str = ""


@dataclass(frozen=True)
class Member:
    id: str
    display_name: str
    user_id: str | None


@dataclass(frozen=True)
class Group:
    id: str
    name: str
    base_currency: str
    members: list[Member]


class LedgerReader:
    def __init__(self, base_url: str, token: str, client: httpx.Client):
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}
        self._client = client

    def _get(self, path: str, params: dict[str, str] | None = None):
        response = self._client.get(f"{self._base}{path}", headers=self._headers, params=params, timeout=10)
        if response.status_code == 404:
            raise NotFound(path)
        response.raise_for_status()
        return response.json()

    def me(self) -> Me:
        m = self._get("/me")
        return Me(id=m["id"], display_name=m["displayName"])

    def groups(self) -> list[GroupSummary]:
        return [
            GroupSummary(id=g["id"], name=g["name"], base_currency=g["baseCurrency"], created_at=g["createdAt"])
            for g in self._get("/groups")
        ]

    def group(self, group_id: str) -> Group:
        g = self._get(f"/groups/{group_id}")
        members = [Member(id=m["id"], display_name=m["displayName"], user_id=m.get("userId")) for m in g["members"]]
        return Group(id=g["id"], name=g["name"], base_currency=g["baseCurrency"], members=members)

    def owed_to_me(self, group_id: str, me_member_id: str, member_id: str) -> dict[str, int]:
        """What member pays me in the group's settle-up plan, per currency (only currencies where it's more than 0)."""
        owed: dict[str, int] = {}
        for c in self._get(f"/groups/{group_id}/balances")["currencies"]:
            total = sum(
                t["amountMinor"]
                for t in c["transfers"]
                if t["fromMemberId"] == member_id and t["toMemberId"] == me_member_id
            )
            if total > 0:
                owed[c["currency"]] = total
        return owed

    def owing(self) -> dict:
        """What I owe and am owed across my groups: the ledger's /me/owing JSON, money already formatted."""
        return self._get("/me/owing")

    def spending(self, group_id: str, from_: str | None, to: str | None, category: str | None, q: str | None) -> dict:
        """A group's spending: the ledger's /groups/{id}/spending JSON. Filters left as None are not sent."""
        params = {k: v for k, v in {"from": from_, "to": to, "category": category, "q": q}.items() if v is not None}
        return self._get(f"/groups/{group_id}/spending", params)

    def open_items(self, group_id: str, from_member: str, to_member: str) -> dict:
        """What's still open between two members: the ledger's /groups/{id}/open-items JSON."""
        return self._get(f"/groups/{group_id}/open-items", {"from": from_member, "to": to_member})

    def expense_lines(
        self,
        group_id: str,
        from_: str | None,
        to: str | None,
        category: str | None,
        q: str | None,
        member: str | None,
        cursor: str | None,
        limit: int = 20,
    ) -> dict:
        """A group's expenses as formatted lines, newest first: the ledger's /groups/{id}/expense-lines JSON."""
        filters = {"from": from_, "to": to, "category": category, "q": q, "member": member, "cursor": cursor}
        params = {k: v for k, v in filters.items() if v is not None} | {"limit": str(limit)}
        return self._get(f"/groups/{group_id}/expense-lines", params)
