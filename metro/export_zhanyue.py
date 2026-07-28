"""把冻结的地铁示意导出为站粤 v3 的 DATA.lines[] 格式。

站粤 ``index.html`` 内嵌 ``let DATA = { lines: [...] }``，其中
- line: {id, name, color, d, bbox, stations[]}
- station: {name, x, y, progress, transfer, lineCount, pinyin, reviewStatus, reviewNote, audioUrl}

渲染一律按 ``progress`` 沿 ``d`` 取点（与站粤 ``pointAtProgress`` 一致），故这里只需写出
``d``（投影后的 SVG path）与 ``progress``，``x/y`` 同时给出便于离线校核。

数据源优先级：``--layout``（工作室保存的人工校核结果）> 线网里的 ``schematic`` 字段 > 即时生成。
"""
from __future__ import annotations

import argparse
import gzip
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .constants import DATA_DIR, NETWORK_PATH
from .schematic import build_schematic_network, point_at_progress

Point = Tuple[float, float]

# 站粤 line.id 命名（见 index.html DATA / geometryAudit）
ROUTE_NO_TO_ID = {
    "1号线": "1",
    "2号线&8号线": "2-8",
    "6号线支线": "6b",
}


def _line_id(route_no: str, short_name: Optional[str]) -> str:
    if route_no in ROUTE_NO_TO_ID:
        return ROUTE_NO_TO_ID[route_no]
    for token, repl in (("2号线&8号线", "2-8"), ("6号线支线", "6b")):
        if token in route_no:
            return repl
    s = (short_name or route_no).replace("号线", "").replace("号线支线", "").strip()
    return s or route_no


def _load_network(network_path: Path) -> Dict[str, Any]:
    with gzip.open(str(network_path), "rt", encoding="utf-8") as handle:
        network = json.load(handle)
    if "transfer_anchors" not in network:
        network = {**network, "routes": [dict(r) for r in network.get("routes", [])]}
        build_schematic_network(network)
    return network


def _apply_layout(network: Dict[str, Any], layout: Dict[str, Any]) -> None:
    lines = layout.get("lines", {})
    anchors = layout.get("anchors", {})
    for route in network.get("routes", []):
        override = lines.get(route["id"])
        if not override or "schematic" not in route:
            continue
        route["schematic"]["path"] = override.get("path", route["schematic"]["path"])
        route["schematic"]["station_progress"] = override.get(
            "station_progress", route["schematic"]["station_progress"]
        )
    ta = network.get("transfer_anchors") or {}
    for key, pos in anchors.items():
        if key in ta and isinstance(pos, dict):
            ta[key]["x"] = pos.get("x", ta[key]["x"])
            ta[key]["y"] = pos.get("y", ta[key]["y"])


def _collect_bbox(routes: List[Dict[str, Any]]) -> Tuple[float, float, float, float]:
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    for route in routes:
        for px, py in route["schematic"]["path"]:
            if px < minx:
                minx = px
            if px > maxx:
                maxx = px
            if py < miny:
                miny = py
            if py > maxy:
                maxy = py
    return minx, miny, maxx, maxy


def _make_projection(bbox: Tuple[float, float, float, float]) -> Dict[str, Any]:
    """世界坐标 y 已朝南增大（北小南大），与站粤 SVG 的 y 向下方向一致；仅缩放和平移，不翻转 y。"""
    minx, miny, maxx, maxy = bbox
    vx, vy, vw, vh = 20.0, 45.0, 1240.0, 625.0
    pad = 30.0
    usable_w = vw - pad * 2
    usable_h = vh - pad * 2
    world_w = max(1.0, maxx - minx)
    world_h = max(1.0, maxy - miny)
    scale = min(usable_w / world_w, usable_h / world_h)
    drawn_w = world_w * scale
    drawn_h = world_h * scale
    off_x = vx + pad + (usable_w - drawn_w) / 2.0
    off_y = vy + pad + (usable_h - drawn_h) / 2.0

    def project(point: Point) -> Point:
        nx = off_x + (point[0] - minx) * scale
        ny = off_y + (point[1] - miny) * scale  # 世界 y 与 SVG y 同向，不翻转
        return (nx, ny)

    return {"project": project, "view": (vx, vy, vw, vh)}


def _path_d(points: List[Point]) -> str:
    return " ".join(
        "{} {:.2f} {:.2f}".format("M" if i == 0 else "L", p[0], p[1])
        for i, p in enumerate(points)
    )


def export(
    network_path: Path = NETWORK_PATH,
    layout_path: Optional[Path] = None,
    output_path: Optional[Path] = None,
) -> Dict[str, Any]:
    network = _load_network(network_path)
    if layout_path and layout_path.exists():
        with open(layout_path, "r", encoding="utf-8") as handle:
            _apply_layout(network, json.load(handle))

    from language_data import StationLanguageStore
    language = StationLanguageStore(DATA_DIR / "station_language.json")

    forward = [r for r in network.get("routes", []) if r.get("direction") == "forward"]
    anchors = network.get("transfer_anchors") or {}
    proj = _make_projection(_collect_bbox(forward))

    def norm(value: str) -> str:
        from .matcher import normalize_name
        return normalize_name(value)

    lines_out: List[Dict[str, Any]] = []
    for route in forward:
        schematic = route.get("schematic") or {}
        path_world = schematic.get("path", [])
        station_progress = schematic.get("station_progress", [])
        stops = route.get("stops", [])
        proj_path = [proj["project"]((p[0], p[1])) for p in path_world]
        xs = [p[0] for p in proj_path] or [0.0]
        ys = [p[1] for p in proj_path] or [0.0]

        stations_out: List[Dict[str, Any]] = []
        for index, stop in enumerate(stops):
            progress = float(station_progress[index]) if index < len(station_progress) else (index / max(1, len(stops) - 1))
            world = point_at_progress(path_world, progress) if len(path_world) >= 2 else (float(stop.get("x", 0)), float(stop.get("y", 0)))
            sx, sy = proj["project"](world)
            key = norm(str(stop.get("name", "")))
            is_transfer = key in anchors
            line_count = len(anchors.get(key, {}).get("lines", [])) or 1
            lang = language.get(str(stop.get("name", "")))
            stations_out.append({
                "name": stop.get("name"),
                "x": round(sx, 2),
                "y": round(sy, 2),
                "progress": round(progress, 6),
                "transfer": is_transfer,
                "lineCount": max(1, line_count),
                "pinyin": lang.get("pinyin", ""),
                "reviewStatus": "unreviewed",
                "reviewNote": lang.get("note", ""),
                "audioUrl": lang.get("audio_url", ""),
            })

        lines_out.append({
            "id": _line_id(route.get("route_no", ""), route.get("short_name")),
            "name": route.get("route_no"),
            "color": route.get("color", "#7da6c8"),
            "d": _path_d(proj_path),
            "bbox": [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)],
            "stations": stations_out,
        })

    data = {
        "sourceDate": network.get("built_at", ""),
        "mapVersion": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "geometryPass": "schematic-octilinear-v1",
        "lines": lines_out,
    }

    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description="导出地铁示意为站粤 DATA.lines[] 格式")
    parser.add_argument("--network", type=Path, default=NETWORK_PATH)
    parser.add_argument("--layout", type=Path, default=DATA_DIR / "metro_schematic_layout.json")
    parser.add_argument("--output", type=Path, default=DATA_DIR / "zhanyue_metro_data.json")
    args = parser.parse_args()
    data = export(args.network, args.layout, args.output)
    lines = data["lines"]
    total_stations = sum(len(line["stations"]) for line in lines)
    print(json.dumps({
        "output": str(args.output),
        "lines": len(lines),
        "stations": total_stations,
        "transfers": sum(1 for line in lines for st in line["stations"] if st["transfer"]),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
