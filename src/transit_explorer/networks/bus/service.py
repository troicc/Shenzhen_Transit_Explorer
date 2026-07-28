"""Bus implementation of the shared network service contract."""

from __future__ import annotations

from typing import Any, Dict

from ...common.network import NetworkService, NetworkSpec
from ...settings import LANGUAGE_PATH
from .config import NETWORK_NAME, NETWORK_PATH
from .matcher import normalize_stop


def _line_count(cluster: Dict[str, Any]) -> int:
    return int(cluster.get("route_count", 1))


service = NetworkService(
    NetworkSpec(
        network_id="bus",
        name=NETWORK_NAME,
        network_path=NETWORK_PATH,
        language_path=LANGUAGE_PATH,
        normalize_station=lambda value: normalize_stop(value),
        cluster_line_count=_line_count,
        missing_detail="尚未生成公交线网；请先完成采集，再运行 transit-explorer build bus。",
        default_operator="深圳公交",
        route_search_fields=("route_no", "start_stop", "end_stop", "operator"),
        station_zoom=2.6,
        station_cap=8000,
    )
)
