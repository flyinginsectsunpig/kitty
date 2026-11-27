"""Runs Ask Kitty's agent with the configured model (Gemini or Ollama) over evals/ask/questions.jsonl, against a fixed
fake ledger (world.json) instead of the real one, and reports how often it called the expected lookups and said (and
didn't say) the expected things. Runs nightly in CI (evals.yml, with --json-out for evals/gate.py), and by hand.

Usage (from services/ai, with AI_GEMINI_API_KEY or AI_OLLAMA_URL set):
  uv run python evals/ask/run.py [--delay 4] [--verbose] [--json-out F]
"""

import argparse
import json
import pathlib
import sys
import time
from datetime import date

import httpx

from kitty_ai.ask.agent import Entry, Message, run_agent, system_prompt
from kitty_ai.ask.models import chat_from
from kitty_ai.ask.tools import run_tool
from kitty_ai.ledger import LedgerReader
from kitty_ai.receipts.extract import RateLimited, UnusableOutput
from kitty_ai.settings import Settings

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from results import model_name, ratio, write_results  # noqa: E402  (evals/ is a folder of scripts, not a package)

HERE = pathlib.Path(__file__).parent
NB = " "


def _text(minor: int) -> str:
    """The ledger's MoneyText for ZAR (the only currency in the world): "R 1 234,56" with no-break spaces."""
    whole, cents = divmod(abs(minor), 100)
    return f"{'-' if minor < 0 else ''}R{NB}{f'{whole:,}'.replace(',', NB)},{cents:02d}"


def _money(minor: int) -> dict:
    return {"currency": "ZAR", "minor": minor, "text": _text(minor)}


def _line(r: dict) -> dict:
    return {
        "expenseId": r["id"],
        "description": r["description"],
        "date": r["date"],
        "category": r["category"],
        "total": _money(r["amountMinor"]),
        "myShare": _money(r["myShareMinor"]),
        "paidBy": " and ".join(p["name"] for p in r["paidBy"]),
    }


def _spending(rows: list[dict], params: dict) -> dict:
    """What the ledger's /groups/{id}/spending returns for these rows and filters (ZAR only)."""
    q = (params.get("q") or "").casefold()
    rows = [
        r
        for r in rows
        if (not params.get("from") or r["date"] >= params["from"])
        and (not params.get("to") or r["date"] <= params["to"])
        and (not params.get("category") or r["category"] == params["category"])
        and q in r["description"].casefold()
    ]
    if not rows:
        return {"groupCurrency": "ZAR", "currencies": [], "converted": None}
    by_category: dict[str, int] = {}
    by_payer: dict[tuple[str, str], int] = {}
    for r in rows:
        by_category[r["category"]] = by_category.get(r["category"], 0) + r["amountMinor"]
        for p in r["paidBy"]:
            by_payer[(p["memberId"], p["name"])] = by_payer.get((p["memberId"], p["name"]), 0) + p["minor"]
    # Biggest by amount, then the later date, then id (Python's sort is stable, so sort the tie-breaks first).
    biggest = sorted(
        sorted(sorted(rows, key=lambda r: r["id"]), key=lambda r: r["date"], reverse=True),
        key=lambda r: -r["amountMinor"],
    )[:5]
    latest = sorted(rows, key=lambda r: (r["date"], r["createdAt"]), reverse=True)[:5]
    return {
        "groupCurrency": "ZAR",
        "currencies": [
            {
                "currency": "ZAR",
                "total": _money(sum(r["amountMinor"] for r in rows)),
                "myShare": _money(sum(r["myShareMinor"] for r in rows)),
                "count": len(rows),
                "byCategory": [
                    {"category": c, "total": _money(v)} for c, v in sorted(by_category.items(), key=lambda kv: -kv[1])
                ],
                "byPayer": [
                    {"memberId": m, "name": n, "paid": _money(v)}
                    for (m, n), v in sorted(by_payer.items(), key=lambda kv: -kv[1])
                ],
                "biggest": [_line(r) for r in biggest],
                "latest": [_line(r) for r in latest],
            }
        ],
        "converted": None,
    }


def world_reader(world: dict) -> LedgerReader:
    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path in world:
            return httpx.Response(200, json=world[path])
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "groups" and parts[2] == "spending" and parts[1] in world["expenses"]:
            return httpx.Response(200, json=_spending(world["expenses"][parts[1]], dict(request.url.params)))
        return httpx.Response(404, json={"code": "not_found"})

    client = httpx.Client(base_url="http://ledger.eval", transport=httpx.MockTransport(handle))
    return LedgerReader("http://ledger.eval", "eval-token", client)


def mentions(answer: str, needle: str) -> bool:
    """Case-insensitive, and a no-break space counts as a space (models copy amounts either way)."""
    return needle.replace(NB, " ").casefold() in answer.replace(NB, " ").casefold()


def main() -> int:
    args = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    args.add_argument(
        "--delay", type=float, default=4.0, help="seconds between questions (free tier: 15 calls a minute)"
    )
    args.add_argument("--verbose", action="store_true")
    args.add_argument("--json-out", type=pathlib.Path, help="also write the scores here, for evals/gate.py")
    opts = args.parse_args()

    chat = chat_from(Settings())
    world = json.loads((HERE / "world.json").read_text(encoding="utf-8"))
    reader = world_reader(world)
    cases = [json.loads(line) for line in (HERE / "questions.jsonl").read_text(encoding="utf-8").splitlines() if line]
    scores = {"calls": [0, 0], "contains": [0, 0], "not_contains": [0, 0], "entry": [0, 0]}
    model_calls = 0
    skipped = 0
    for case in cases:
        conversation = [Message(m["role"], m["text"]) for m in case["conversation"]]
        system = system_prompt(date.fromisoformat(case["today"]), world["/me"]["displayName"], None)
        for attempt in range(3):
            try:
                outcome, used, calls = run_agent(chat, system, conversation, lambda n, a: run_tool(reader, n, a))
                break
            except RateLimited:
                time.sleep(20 * (attempt + 1))
            except UnusableOutput:
                outcome, used, calls = None, [], 0
                break
        else:
            print(f"gave up (rate limited): {conversation[-1].text}", file=sys.stderr)
            skipped += 1
            continue
        model_calls += calls
        expect = case["expect"]
        answer = outcome.text if outcome is not None and not isinstance(outcome, Entry) else ""
        checks = {
            "entry": [isinstance(outcome, Entry) == bool(expect.get("entry"))],
            "calls": [set(expect["calls"]) <= set(used)] if "calls" in expect else [],
            "contains": [mentions(answer, s) for s in expect.get("contains", [])],
            "not_contains": [not mentions(answer, s) for s in expect.get("not_contains", [])],
        }
        for name, results in checks.items():
            scores[name][0] += sum(results)
            scores[name][1] += len(results)
        if opts.verbose and not all(all(r) for r in checks.values()):
            print(f"✗ {conversation[-1].text}\n  lookups: {used}\n  answer: {answer or outcome!r}\n")
        time.sleep(opts.delay)

    for name, (right, total) in scores.items():
        if total:
            print(f"{name}_pass {right / total:.2f} ({right}/{total})")
    print(f"model_calls {model_calls} over {len(cases)} questions")
    if opts.json_out:
        metrics = {name: ratio(right, total) for name, (right, total) in scores.items() if total}
        write_results(opts.json_out, "ask", model_name(), len(cases), skipped, metrics, {"model_calls": model_calls})
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # a Windows pipe defaults to cp1252, which has no ✗
    sys.exit(main())
