"""Metro implementation of the shared network service contract."""

from __future__ import annotations

from typing import Any, Dict

from ...common.network import NetworkService, NetworkSpec
from ...settings import LANGUAGE_PATH
from .config import NETWORK_NAME, NETWORK_PATH
from .matcher import normalize_name


def _line_count(cluster: Dict[str, Any]) -> int:
    route_numbers = cluster.get("route_nos", [])
    return len(route_numbers) if route_numbers else int(cluster.get("route_count", 1))


service = NetworkService(
    NetworkSpec(
        network_id="metro",
        name=NETWORK_NAME,
        network_path=NETWORK_PATH,
        language_path=LANGUAGE_PATH,
        normalize_station=normalize_name,
        cluster_line_count=_line_count,
        missing_detail="尚未生成地铁线网；请先完成采集，再运行 transit-explorer build metro。",
        default_operator="深圳地铁",
        route_search_fields=("route_no", "short_name", "start_stop", "end_stop"),
        station_zoom=2.0,
        default_color="#5cc8ff",
    )
)
