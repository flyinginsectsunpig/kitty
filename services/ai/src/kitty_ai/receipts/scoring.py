"""How well receipt reading does against hand-labelled receipts: total accuracy (the printed total read exactly)
and line-item F1 (an item counts when its line total is equal and its name is close enough)."""

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from kitty_ai.contracts.kitty.events.v1 import receipts_pb2 as pb

NAME_SIMILARITY = 0.8


@dataclass(frozen=True)
class ReceiptLabel:
    items: list[tuple[str, int]]  # (description, line total in minor units)
    total_minor: int


@dataclass(frozen=True)
class Scores:
    receipts: int
    total_accuracy: float
    item_f1: float


def _name(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()


def _matches(label: list[tuple[str, int]], predicted: list[tuple[str, int]]) -> int:
    """Pairs each predicted item with at most one labelled item (greedy, best name first)."""
    unused = list(label)
    found = 0
    for name, minor in predicted:
        candidates = [
            (SequenceMatcher(None, _name(name), _name(lname)).ratio(), i)
            for i, (lname, lminor) in enumerate(unused)
            if lminor == minor
        ]
        best = max(candidates, default=(0.0, -1))
        if best[0] >= NAME_SIMILARITY:
            unused.pop(best[1])
            found += 1
    return found


def score(pairs: list[tuple[ReceiptLabel, pb.ParsedReceipt | int]]) -> Scores:
    """Scores predictions (a ParsedReceipt, or a failure reason) against their labels."""
    totals_right = true_pos = predicted = labelled = 0
    for label, outcome in pairs:
        labelled += len(label.items)
        if not isinstance(outcome, pb.ParsedReceipt):
            continue
        items = [(i.description, i.line_total_minor) for i in outcome.items]
        predicted += len(items)
        true_pos += _matches(label.items, items)
        totals_right += outcome.total_minor == label.total_minor
    precision = true_pos / predicted if predicted else 0.0
    recall = true_pos / labelled if labelled else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return Scores(receipts=len(pairs), total_accuracy=totals_right / len(pairs) if pairs else 0.0, item_f1=f1)


def describe_outcome(outcome: pb.ParsedReceipt | int) -> str:
    """One word for a scan's result, with the failure reason when it failed: "read" or "failed (model_unavailable)"."""
    if isinstance(outcome, pb.ParsedReceipt):
        return "read"
    return f"failed ({pb.ScanFailure.Reason.Name(outcome).lower()})"
