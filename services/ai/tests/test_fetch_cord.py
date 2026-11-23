import importlib.util
import json
import pathlib

_spec = importlib.util.spec_from_file_location(
    "fetch_cord", pathlib.Path(__file__).resolve().parents[1] / "evals" / "fetch_cord.py"
)
fetch_cord = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fetch_cord)


def gt(parse: dict) -> str:
    return json.dumps({"gt_parse": parse})


def test_cord_menu_becomes_items_in_idr_minor_units():
    label = fetch_cord.to_label(
        gt(
            {
                "menu": [
                    {"nm": "NASI GORENG", "cnt": "2", "price": "50,000"},
                    {"nm": "ES TEH", "cnt": "1", "price": "8,000"},
                ],
                "total": {"total_price": "58,000"},
            }
        )
    )
    assert label == {
        "currency": "IDR",
        "items": [
            {"description": "NASI GORENG", "quantity": 2, "line_total_minor": 5_000_000},
            {"description": "ES TEH", "quantity": 1, "line_total_minor": 800_000},
        ],
        "total_minor": 5_800_000,
    }


def test_single_item_menu_and_missing_count():
    label = fetch_cord.to_label(gt({"menu": {"nm": "KOPI", "price": "15,000"}, "total": {"total_price": "15,000"}}))
    assert label["items"] == [{"description": "KOPI", "quantity": 1, "line_total_minor": 1_500_000}]


def test_receipts_without_items_or_total_are_skipped():
    assert fetch_cord.to_label(gt({"menu": [], "total": {"total_price": "1,000"}})) is None
    assert fetch_cord.to_label(gt({"menu": [{"nm": "KOPI", "price": "15,000"}]})) is None
