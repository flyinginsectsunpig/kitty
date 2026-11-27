import pytest

from helpers import EDGE_CHART, KITTY_CHARTS, REPO, SUPPORT_CHARTS

ALL_CHARTS = KITTY_CHARTS + SUPPORT_CHARTS + [EDGE_CHART]


@pytest.mark.xfail(strict=True, reason="charts land in Tasks 2-5; the mark goes in Task 7")
@pytest.mark.parametrize("chart", ALL_CHARTS)
def test_every_chart_has_production_values(chart):
    assert (REPO / "deploy" / "charts" / chart / "Chart.yaml").is_file()
    assert (REPO / "deploy" / "values" / "production" / f"{chart}.yaml").is_file()
