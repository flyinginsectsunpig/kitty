from kitty_ai.contracts.kitty.events.v1 import receipts_pb2 as pb
from kitty_ai.receipts.scoring import ReceiptLabel, score


def parsed(items, total) -> pb.ParsedReceipt:
    return pb.ParsedReceipt(
        items=[pb.ParsedItem(description=d, quantity=1, line_total_minor=m) for d, m in items], total_minor=total
    )


def test_scoring():
    pairs = [
        # All three items found (case and punctuation don't matter), total right.
        (
            ReceiptLabel(items=[("Burger", 12000), ("Coke", 5000), ("Chips", 3000)], total_minor=20000),
            parsed([("burger", 12000), ("Coke.", 5000), ("Chips", 3000)], 20000),
        ),
        # One item right, one invented, one missed; total wrong.
        (
            ReceiptLabel(items=[("Pizza", 20000), ("Water", 2000)], total_minor=22000),
            parsed([("Pizza", 20000), ("Salad", 3000)], 23000),
        ),
    ]
    scores = score(pairs)
    assert scores.receipts == 2
    assert scores.total_accuracy == 0.5
    assert round(scores.item_f1, 6) == 0.8  # 4 found, 1 invented, 1 missed


def test_a_failed_scan_counts_as_wrong_and_finds_nothing():
    scores = score([(ReceiptLabel(items=[("Burger", 12000)], total_minor=12000), pb.ScanFailure.Reason.UNREADABLE)])
    assert (scores.total_accuracy, scores.item_f1) == (0.0, 0.0)


def test_same_price_but_different_item_does_not_match():
    scores = score([(ReceiptLabel(items=[("Burger", 12000)], total_minor=12000), parsed([("Steak", 12000)], 12000))])
    assert scores.item_f1 == 0.0
