"""Metro implementation of the shared network service contract."""

from __future__ import annotations

from typing import Any, Dict

from ...common.network import NetworkService, NetworkSpec
from ...settings import LANGUAGE_PATH
from .config import NETWORK_NAME, NETWORK_PATH
from .matcher import normalize_name
from .presentation import MetroPresentationRepository, presentation_repository


def _line_count(cluster: Dict[str, Any]) -> int:
    route_numbers = cluster.get("route_nos", [])
    return len(route_numbers) if route_numbers else int(cluster.get("route_count", 1))


class MetroNetworkService(NetworkService):
    """Shared query service with the final Metro presentation overlay."""

    def __init__(self, spec: NetworkSpec, presentation: MetroPresentationRepository):
        super().__init__(spec)
        self.presentation_repository = presentation

    def invalidate_presentation(self) -> None:
        self.presentation_repository.invalidate()

    def presentation(self) -> Dict[str, Any]:
        return self.presentation_repository.presentation(self.require_network())

    def presentation_revision(self) -> Dict[str, Any]:
        network = self.require_network()
        return {
            "network": "metro",
            "revision": self.presentation_repository.revision(network),
        }

    def learning_route(self, route_id: str) -> Dict[str, Any]:
        payload = super().learning_route(route_id)
        try:
            route = self.presentation_repository.get_route(route_id, self.require_network())
        except KeyError:
            return payload
        payload["geometry"] = dict(payload.get("geometry") or {})
        focus = (route.get("geometry") or {}).get("focus")
        if focus:
            payload["geometry"]["focus"] = focus
            payload["presentation_revision"] = focus.get("revision")
        return payload


service = MetroNetworkService(
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
    ),
    presentation_repository,
)
