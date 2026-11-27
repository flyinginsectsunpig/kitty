import pytest

from helpers import EDGE_CHART, KITTY_CHARTS, REPO, SUPPORT_CHARTS

ALL_CHARTS = KITTY_CHARTS + SUPPORT_CHARTS + [EDGE_CHART]
# Charts not built yet (each task removes its own; empty, and gone, by Task 7).
PENDING = {*KITTY_CHARTS, EDGE_CHART}


@pytest.mark.parametrize(
    "chart",
    [pytest.param(c, marks=pytest.mark.xfail(strict=True, reason="not built yet")) if c in PENDING else c
     for c in ALL_CHARTS],
)  # fmt: skip
def test_every_chart_has_production_values(chart):
    assert (REPO / "deploy" / "charts" / chart / "Chart.yaml").is_file()
    assert (REPO / "deploy" / "values" / "production" / f"{chart}.yaml").is_file()
