"""Canonical internal presentation model for the metro network.

The generated network remains the geographic source of truth.  The optional
Studio layout is an authoring overlay.  Every trusted consumer (Studio, Learn
and the public publisher) obtains its final schematic geometry here so the
three paths cannot silently drift apart again.
"""

from __future__ import annotations

import copy
import gzip
import hashlib
import json
import math
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from ...features.schematic import build_schematic_network, point_at_progress
from .config import LAYOUT_PATH, NETWORK_PATH
from .matcher import normalize_name


Point = List[float]


_REGION_LABELS = (
    ("宝安", 0.1406, 0.2040, "district"),
    ("南山", 0.2438, 0.7360, "district"),
    ("福田", 0.4570, 0.7360, "district"),
    ("罗湖", 0.6094, 0.7440, "district"),
    ("龙华", 0.4180, 0.2360, "district"),
    ("龙岗", 0.7227, 0.5040, "district"),
    ("坪山", 0.8633, 0.2880, "district"),
    ("盐田", 0.8320, 0.8000, "district"),
    ("深 圳 湾 · 香 港", 0.4805, 0.9440, "water"),
)


def _file_signature(path: Path) -> Tuple[int, int]:
    try:
        stat = path.stat()
    except OSError:
        return (-1, -1)
    return (stat.st_mtime_ns, stat.st_size)


def _finite_number(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _logical_line_id(route: Mapping[str, Any]) -> str:
    short_name = str(route.get("short_name") or "").strip()
    if short_name:
        return short_name
    official_id = str(route.get("official_id") or "").strip()
    if official_id.startswith("metro-"):
        official_id = official_id[6:]
    if official_id:
        return official_id
    return str(route.get("id") or "").split(":", 1)[0]


def _bbox(points: Sequence[Sequence[float]]) -> List[float]:
    return [
        min(float(point[0]) for point in points),
        min(float(point[1]) for point in points),
        max(float(point[0]) for point in points),
        max(float(point[1]) for point in points),
    ]


def _normalized_path(value: Any) -> Optional[List[Point]]:
    if not isinstance(value, list) or not 2 <= len(value) <= 4000:
        return None
    output: List[Point] = []
    for point in value:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            return None
        x = _finite_number(point[0])
        y = _finite_number(point[1])
        if x is None or y is None or abs(x) > 10_000_000 or abs(y) > 10_000_000:
            return None
        output.append([x, y])
    return output


def _normalized_progresses(value: Any, count: int) -> Optional[List[float]]:
    if not isinstance(value, list) or len(value) != count or count < 2:
        return None
    output: List[float] = []
    previous = -1.0
    for raw in value:
        number = _finite_number(raw)
        if number is None or number < 0 or number > 1 or number + 1e-9 < previous:
            return None
        output.append(max(previous, number))
        previous = output[-1]
    if output[0] > 1e-6 or output[-1] < 1 - 1e-6:
        return None
    output[0] = 0.0
    output[-1] = 1.0
    return output


class MetroPresentationRepository:
    """Merge a generated network and the trusted Studio layout once."""

    def __init__(self, network_path: Path = NETWORK_PATH, layout_path: Path = LAYOUT_PATH):
        self.network_path = Path(network_path)
        self.layout_path = Path(layout_path)
        self._lock = threading.RLock()
        self._cache_key: Optional[Tuple[Any, ...]] = None
        self._cache: Optional[Dict[str, Any]] = None
        self._cache_source: Optional[Dict[str, Any]] = None

    def invalidate(self) -> None:
        with self._lock:
            self._cache_key = None
            self._cache = None
            self._cache_source = None

    def _load_network(self) -> Dict[str, Any]:
        if not self.network_path.is_file():
            raise FileNotFoundError(str(self.network_path))
        opener = gzip.open if self.network_path.suffix == ".gz" else open
        with opener(str(self.network_path), "rt", encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict) or not isinstance(payload.get("routes"), list):
            raise ValueError("地铁线网文件缺少 routes")
        return payload

    def _load_layout(self) -> Dict[str, Any]:
        if not self.layout_path.is_file():
            return {}
        try:
            payload = json.loads(self.layout_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _prepare_base(self, base_network: Dict[str, Any]) -> Dict[str, Any]:
        network = copy.deepcopy(base_network)
        forward = [route for route in network.get("routes", []) if route.get("direction") == "forward"]
        if "transfer_anchors" not in network or any(
            not (route.get("schematic") or {}).get("path") for route in forward
        ):
            build_schematic_network(network, normalize=normalize_name)
        return network

    @staticmethod
    def _layout_override(layout: Mapping[str, Any], route: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
        lines = layout.get("lines")
        if not isinstance(lines, Mapping):
            return None
        route_id = str(route.get("id") or "")
        official_id = str(route.get("official_id") or "")
        candidates = (
            _logical_line_id(route),
            official_id,
            route_id,
            route_id.removesuffix(":forward"),
        )
        for key in candidates:
            override = lines.get(key)
            if isinstance(override, Mapping):
                return override
        return None

    @staticmethod
    def _focus_geometry(
        route: Mapping[str, Any],
        path: List[Point],
        progresses: List[float],
        revision: str,
        source: str,
    ) -> Dict[str, Any]:
        return {
            "source": source,
            "revision": revision,
            "path": path,
            "stationProgresses": progresses,
            "stationPoints": [list(point_at_progress(path, progress)) for progress in progresses],
            "bbox": _bbox(path),
            "logicalLineId": _logical_line_id(route),
        }

    @staticmethod
    def _revision_payload(network: Mapping[str, Any], layout: Mapping[str, Any]) -> bytes:
        forward = []
        for route in network.get("routes", []):
            if route.get("direction") != "forward":
                continue
            schematic = route.get("schematic") or {}
            forward.append(
                {
                    "id": route.get("id"),
                    "official_id": route.get("official_id"),
                    "path": schematic.get("path"),
                    "station_progress": schematic.get("station_progress"),
                    "stops": [stop.get("name") for stop in route.get("stops", [])],
                }
            )
        payload = {
            "version": network.get("version"),
            "built_at": network.get("built_at"),
            "forward": forward,
            "layout": layout,
        }
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

    def get_network(self, base_network: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        source = base_network if base_network is not None else self._load_network()
        cache_key = (
            id(source),
            _file_signature(self.network_path) if base_network is None else source.get("built_at"),
            _file_signature(self.layout_path),
        )
        with self._lock:
            if self._cache_source is source and self._cache_key == cache_key and self._cache is not None:
                return copy.deepcopy(self._cache)

            network = self._prepare_base(source)
            layout = self._load_layout()
            revision = "metro-presentation-{}".format(
                hashlib.sha256(self._revision_payload(network, layout)).hexdigest()[:16]
            )
            route_by_official: Dict[str, Dict[str, Any]] = {}

            for route in network.get("routes", []):
                if route.get("direction") != "forward":
                    continue
                schematic = route.get("schematic") or {}
                path = _normalized_path(schematic.get("path"))
                progresses = _normalized_progresses(schematic.get("station_progress"), len(route.get("stops", [])))
                if path is None or progresses is None:
                    continue
                override = self._layout_override(layout, route)
                source_name = "metro-schematic"
                if override:
                    override_path = _normalized_path(override.get("path"))
                    override_progresses = _normalized_progresses(
                        override.get("station_progress", override.get("stationProgresses")),
                        len(route.get("stops", [])),
                    )
                    if override_path is not None and override_progresses is not None:
                        path = override_path
                        progresses = override_progresses
                        source_name = "metro-layout"
                route["schematic"] = {**schematic, "path": path, "station_progress": progresses}
                route["geometry"] = {
                    **(route.get("geometry") or {}),
                    "focus": self._focus_geometry(route, path, progresses, revision, source_name),
                }
                route_by_official[str(route.get("official_id") or _logical_line_id(route))] = route

            for route in network.get("routes", []):
                if route.get("direction") == "forward":
                    continue
                forward_route = route_by_official.get(str(route.get("official_id") or _logical_line_id(route)))
                focus = (forward_route or {}).get("geometry", {}).get("focus")
                if not focus:
                    continue
                forward_progresses = list(focus["stationProgresses"])
                path = [list(point) for point in reversed(focus["path"])]
                progresses = [1.0 - float(value) for value in reversed(forward_progresses)]
                progresses[0] = 0.0
                progresses[-1] = 1.0
                route["schematic"] = {"path": path, "station_progress": progresses, "derived": True}
                route["geometry"] = {
                    **(route.get("geometry") or {}),
                    "focus": self._focus_geometry(
                        route,
                        path,
                        progresses,
                        revision,
                        "{}-reverse".format(focus.get("source", "metro-schematic")),
                    ),
                }

            anchors = network.get("transfer_anchors") or {}
            layout_anchors = layout.get("anchors") if isinstance(layout.get("anchors"), Mapping) else {}
            for key, anchor in anchors.items():
                override = layout_anchors.get(key) if isinstance(layout_anchors, Mapping) else None
                if not isinstance(override, Mapping):
                    continue
                x = _finite_number(override.get("x"))
                y = _finite_number(override.get("y"))
                if x is not None and y is not None:
                    anchor["x"] = x
                    anchor["y"] = y

            network["presentation_revision"] = revision
            network["presentation_layout"] = {
                "applied": bool(layout),
                "saved_at": layout.get("saved_at"),
                "alpha": layout.get("alpha", network.get("schematic_alpha", 0.55)),
                "key_version": int(layout.get("key_version", 1)) if layout else 0,
            }
            self._cache_key = cache_key
            self._cache = network
            self._cache_source = source
            return copy.deepcopy(network)

    def get_route(self, route_id: str, base_network: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        network = self.get_network(base_network)
        for route in network.get("routes", []):
            if str(route.get("id")) == route_id:
                return route
        raise KeyError(route_id)

    def revision(self, base_network: Optional[Dict[str, Any]] = None) -> str:
        return str(self.get_network(base_network).get("presentation_revision", ""))

    def presentation(self, base_network: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        network = self.get_network(base_network)
        anchors = network.get("transfer_anchors") or {}
        routes = []
        directions: Dict[str, Dict[str, str]] = {}
        for route in network.get("routes", []):
            logical_id = _logical_line_id(route)
            directions.setdefault(logical_id, {})[str(route.get("direction") or "forward")] = str(route.get("id"))
            if route.get("direction") != "forward":
                continue
            focus = (route.get("geometry") or {}).get("focus")
            if not focus:
                continue
            stops = []
            for index, stop in enumerate(route.get("stops", [])):
                anchor = anchors.get(normalize_name(str(stop.get("name", "")))) or {}
                line_count = max(1, len(anchor.get("lines", [])), int(stop.get("lineCount", 1) or 1))
                stops.append(
                    {
                        "name": stop.get("name"),
                        "index": index,
                        "transfer": line_count > 1,
                        "lineCount": line_count,
                    }
                )
            routes.append(
                {
                    "id": route.get("id"),
                    "official_id": route.get("official_id"),
                    "logical_id": logical_id,
                    "route_no": route.get("route_no"),
                    "short_name": route.get("short_name"),
                    "color": route.get("color"),
                    "start_stop": route.get("start_stop"),
                    "end_stop": route.get("end_stop"),
                    "bbox": focus.get("bbox"),
                    "path": focus.get("path"),
                    "station_progress": focus.get("stationProgresses"),
                    "station_points": focus.get("stationPoints"),
                    "stops": stops,
                }
            )
        world = network.get("world") or {"width": 10000, "height": 6000}
        width = float(world.get("width", 10000) or 10000)
        height = float(world.get("height", 6000) or 6000)
        regions = [
            {"name": name, "x": width * x, "y": height * y, "kind": kind}
            for name, x, y, kind in _REGION_LABELS
        ]
        return {
            "network_id": "metro",
            "name": network.get("name") or "深圳地铁",
            "version": network.get("version"),
            "built_at": network.get("built_at"),
            "revision": network.get("presentation_revision"),
            "layout": network.get("presentation_layout"),
            "world": world,
            "routes": routes,
            "directions": directions,
            "transfer_anchors": anchors,
            "regions": regions,
        }

    def normalize_layout(self, payload: Mapping[str, Any], base_network: Dict[str, Any]) -> Dict[str, Any]:
        network = self.get_network(base_network)
        forward = [route for route in network.get("routes", []) if route.get("direction") == "forward"]
        route_lookup: Dict[str, Dict[str, Any]] = {}
        for route in forward:
            for key in {
                _logical_line_id(route),
                str(route.get("id") or ""),
                str(route.get("official_id") or ""),
                str(route.get("id") or "").removesuffix(":forward"),
            }:
                if key:
                    route_lookup[key] = route

        alpha = _finite_number(payload.get("alpha"))
        if alpha is None or not 0 <= alpha <= 1:
            raise ValueError("alpha 必须是 0 到 1 之间的数字")
        raw_lines = payload.get("lines")
        if not isinstance(raw_lines, Mapping) or len(raw_lines) > 128:
            raise ValueError("lines 必须是有效线路对象")
        lines: Dict[str, Any] = {}
        for raw_key, override in raw_lines.items():
            route = route_lookup.get(str(raw_key))
            if route is None or not isinstance(override, Mapping):
                raise ValueError("布局包含未知线路：{}".format(raw_key))
            path = _normalized_path(override.get("path"))
            progresses = _normalized_progresses(
                override.get("station_progress", override.get("stationProgresses")),
                len(route.get("stops", [])),
            )
            if path is None or progresses is None:
                raise ValueError("线路 {} 的 path 或 station_progress 无效".format(raw_key))
            lines[_logical_line_id(route)] = {"path": path, "station_progress": progresses}

        raw_anchors = payload.get("anchors")
        if not isinstance(raw_anchors, Mapping) or len(raw_anchors) > 1000:
            raise ValueError("anchors 必须是有效锚点对象")
        known_anchors = network.get("transfer_anchors") or {}
        anchors: Dict[str, Dict[str, float]] = {}
        for key, override in raw_anchors.items():
            if key not in known_anchors or not isinstance(override, Mapping):
                raise ValueError("布局包含未知换乘锚点：{}".format(key))
            x = _finite_number(override.get("x"))
            y = _finite_number(override.get("y"))
            if x is None or y is None or abs(x) > 10_000_000 or abs(y) > 10_000_000:
                raise ValueError("换乘锚点 {} 坐标无效".format(key))
            anchors[str(key)] = {"x": x, "y": y}
        return {"key_version": 2, "alpha": alpha, "lines": lines, "anchors": anchors}

    def save_layout(self, layout: Mapping[str, Any]) -> None:
        self.layout_path.parent.mkdir(parents=True, exist_ok=True)
        encoded = json.dumps(layout, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        descriptor, temporary_name = tempfile.mkstemp(
            prefix="layout-", suffix=".json.tmp", dir=str(self.layout_path.parent)
        )
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, self.layout_path)
        finally:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
        self.invalidate()


presentation_repository = MetroPresentationRepository()
