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

    def _get(self, path: str):
        response = self._client.get(f"{self._base}{path}", headers=self._headers, timeout=10)
        if response.status_code == 404:
            raise NotFound(path)
        response.raise_for_status()
        return response.json()

    def me(self) -> Me:
        m = self._get("/me")
        return Me(id=m["id"], display_name=m["displayName"])

    def groups(self) -> list[GroupSummary]:
        return [GroupSummary(id=g["id"], name=g["name"], base_currency=g["baseCurrency"]) for g in self._get("/groups")]

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
