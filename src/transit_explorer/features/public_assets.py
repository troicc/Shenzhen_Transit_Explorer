"""Build and audit geometry-safe public derivatives for every network.

The functions in this module run only on the trusted build machine.  Exact
schematic paths are rasterised here and are never required by the public
service at runtime.
"""

from __future__ import annotations

import gzip
import json
import math
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


Point = Tuple[float, float]
VIEWPORT_WIDTH = 1280
VIEWPORT_HEIGHT = 720
RASTER_LEVELS = (1, 2, 4)
ANCHOR_GRID = 8
ATLAS_FRAMES = 9
ATLAS_COLUMNS = 3
_PATH_TOKEN = re.compile(r"[ML]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?", re.IGNORECASE)


def safe_line_id(value: object) -> str:
    identifier = re.sub(r"[^0-9A-Za-z._-]+", "-", str(value)).strip("-")
    if not identifier:
        raise ValueError("线路 id 不能为空")
    return identifier


def parse_path(path_d: str) -> List[Point]:
    tokens = _PATH_TOKEN.findall(path_d)
    points: List[Point] = []
    index = 0
    while index < len(tokens):
        if tokens[index].upper() not in {"M", "L"} or index + 2 >= len(tokens):
            raise ValueError("公开资产构建仅支持 M/L SVG 路径")
        points.append((float(tokens[index + 1]), float(tokens[index + 2])))
        index += 3
    if len(points) < 2:
        raise ValueError("线路至少需要两个路径点")
    return points


def path_metrics(points: Sequence[Point]) -> Tuple[List[float], float]:
    cumulative = [0.0]
    for index in range(1, len(points)):
        cumulative.append(
            cumulative[-1]
            + math.hypot(
                points[index][0] - points[index - 1][0],
                points[index][1] - points[index - 1][1],
            )
        )
    return cumulative, cumulative[-1]


def point_at_progress(
    points: Sequence[Point], progress: float, metrics: Optional[Tuple[Sequence[float], float]] = None
) -> Point:
    cumulative, total = metrics or path_metrics(points)
    if total <= 0:
        return points[0]
    target = max(0.0, min(1.0, float(progress))) * total
    for index in range(1, len(points)):
        if cumulative[index] >= target:
            span = cumulative[index] - cumulative[index - 1]
            ratio = 0.0 if span <= 0 else (target - cumulative[index - 1]) / span
            return (
                points[index - 1][0] + (points[index][0] - points[index - 1][0]) * ratio,
                points[index - 1][1] + (points[index][1] - points[index - 1][1]) * ratio,
            )
    return points[-1]


def path_slice(points: Sequence[Point], start: float, end: float) -> List[Point]:
    cumulative, total = path_metrics(points)
    if total <= 0:
        return [points[0], points[-1]]
    low, high = sorted((max(0.0, min(1.0, start)), max(0.0, min(1.0, end))))
    low_distance, high_distance = low * total, high * total
    output = [point_at_progress(points, low, (cumulative, total))]
    for index in range(1, len(points) - 1):
        if low_distance < cumulative[index] < high_distance:
            output.append(points[index])
    output.append(point_at_progress(points, high, (cumulative, total)))
    return output if start <= end else list(reversed(output))


def fit_path(points: Sequence[Point]) -> List[Point]:
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    width = max(1.0, max(xs) - min(xs))
    height = max(1.0, max(ys) - min(ys))
    margin_x, margin_y = 110.0, 86.0
    scale = min(
        (VIEWPORT_WIDTH - margin_x * 2) / width,
        (VIEWPORT_HEIGHT - margin_y * 2) / height,
    )
    offset_x = (VIEWPORT_WIDTH - width * scale) / 2.0
    offset_y = (VIEWPORT_HEIGHT - height * scale) / 2.0
    return [
        (offset_x + (point[0] - min(xs)) * scale, offset_y + (point[1] - min(ys)) * scale)
        for point in points
    ]


def quantized_anchor(point: Point) -> List[int]:
    return [
        int(round(point[0] / ANCHOR_GRID) * ANCHOR_GRID),
        int(round(point[1] / ANCHOR_GRID) * ANCHOR_GRID),
    ]


def _rgb(color: str) -> Tuple[int, int, int]:
    from PIL import ImageColor

    try:
        return ImageColor.getrgb(color)[:3]
    except ValueError:
        return (92, 200, 255)


def _scaled(points: Sequence[Point], scale: int, offset: Point = (0.0, 0.0)) -> List[Point]:
    return [((point[0] - offset[0]) * scale, (point[1] - offset[1]) * scale) for point in points]


def _save_webp(image: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="WEBP", lossless=True, quality=92, method=4)


def _draw_route(draw: Any, points: Sequence[Point], color: Tuple[int, int, int], scale: int, muted: bool) -> None:
    draw.line(points, fill=(2, 7, 13, 238), width=18 * scale, joint="curve")
    draw.line(
        points,
        fill=color + ((132 if muted else 242),),
        width=(9 if muted else 10) * scale,
        joint="curve",
    )


def _draw_vehicle(draw: Any, point: Point, color: Tuple[int, int, int], scale: int = 1) -> None:
    x, y = point
    halo = 14 * scale
    radius = 7 * scale
    draw.ellipse((x - halo, y - halo, x + halo, y + halo), fill=color + (48,))
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(250, 253, 255, 255))
    inner = 4 * scale
    draw.ellipse((x - inner, y - inner, x + inner, y + inner), fill=color + (255,))


def _build_base_rasters(
    points: Sequence[Point],
    stations: Sequence[Mapping[str, Any]],
    color: Tuple[int, int, int],
    output: Path,
    url_base: str,
    scales: Sequence[int],
) -> List[Dict[str, Any]]:
    from PIL import Image, ImageDraw

    metrics = path_metrics(points)
    levels: List[Dict[str, Any]] = []
    for scale in scales:
        image = Image.new("RGBA", (VIEWPORT_WIDTH * scale, VIEWPORT_HEIGHT * scale), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image, "RGBA")
        _draw_route(draw, _scaled(points, scale), color, scale, muted=True)
        for station in stations:
            x, y = point_at_progress(points, float(station.get("progress", 0)), metrics)
            x *= scale
            y *= scale
            radius = (6 if station.get("transfer") else 4) * scale
            draw.ellipse(
                (x - radius, y - radius, x + radius, y + radius),
                fill=(247, 251, 255, 245),
                outline=color + (255,),
                width=max(2, 2 * scale),
            )
        filename = f"base@{scale}x.webp"
        _save_webp(image, output / filename)
        levels.append({"scale": scale, "url": f"{url_base}/{filename}"})
    return levels


def _segment_crop(segment: Sequence[Point]) -> Tuple[int, int, int, int]:
    xs = [point[0] for point in segment]
    ys = [point[1] for point in segment]
    padding = 30
    left = max(0, int(math.floor((min(xs) - padding) / ANCHOR_GRID) * ANCHOR_GRID))
    top = max(0, int(math.floor((min(ys) - padding) / ANCHOR_GRID) * ANCHOR_GRID))
    right = min(VIEWPORT_WIDTH, int(math.ceil((max(xs) + padding) / ANCHOR_GRID) * ANCHOR_GRID))
    bottom = min(VIEWPORT_HEIGHT, int(math.ceil((max(ys) + padding) / ANCHOR_GRID) * ANCHOR_GRID))
    return left, top, max(left + 24, right), max(top + 24, bottom)


def _build_segment_assets(
    points: Sequence[Point],
    start: float,
    end: float,
    index: int,
    color: Tuple[int, int, int],
    output: Path,
    url_base: str,
) -> Dict[str, Any]:
    from PIL import Image, ImageDraw

    segment = path_slice(points, start, end)
    left, top, right, bottom = _segment_crop(segment)
    width, height = right - left, bottom - top
    complete = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    complete_draw = ImageDraw.Draw(complete, "RGBA")
    complete_draw.line(_scaled(segment, 1, (left, top)), fill=color + (248,), width=10, joint="curve")
    completed_name = f"segment-{index:02d}.webp"
    _save_webp(complete, output / completed_name)

    atlas_urls: Dict[str, str] = {}
    for direction in ("forward", "reverse"):
        rows = math.ceil(ATLAS_FRAMES / ATLAS_COLUMNS)
        atlas = Image.new("RGBA", (width * ATLAS_COLUMNS, height * rows), (0, 0, 0, 0))
        atlas_draw = ImageDraw.Draw(atlas, "RGBA")
        for frame in range(ATLAS_FRAMES):
            ratio = frame / float(ATLAS_FRAMES - 1)
            progress = start + (end - start) * ratio
            if direction == "forward":
                travelled = path_slice(points, start, progress)
            else:
                progress = end - (end - start) * ratio
                travelled = path_slice(points, end, progress)
            column = frame % ATLAS_COLUMNS
            row = frame // ATLAS_COLUMNS
            offset = (left - column * width, top - row * height)
            local = _scaled(travelled, 1, offset)
            if len(local) >= 2:
                atlas_draw.line(local, fill=color + (250,), width=10, joint="curve")
            _draw_vehicle(atlas_draw, local[-1], color)
        atlas_name = f"segment-{index:02d}-{direction}.webp"
        _save_webp(atlas, output / atlas_name)
        atlas_urls[direction] = f"{url_base}/{atlas_name}"

    return {
        "from": index,
        "to": index + 1,
        "origin": [left, top],
        "size": [width, height],
        "completedUrl": f"{url_base}/{completed_name}",
        "atlasUrls": atlas_urls,
        "frameCount": ATLAS_FRAMES,
        "columns": ATLAS_COLUMNS,
    }


def build_route_scene(
    line: Mapping[str, Any],
    output_root: Path,
    network_id: str,
    strategy: str,
) -> Tuple[Dict[str, Any], Dict[str, int]]:
    line_id = str(line.get("id", ""))
    safe_id = safe_line_id(line_id)
    output = output_root / "assets" / network_id / "routes" / safe_id
    url_base = f"/assets/{network_id}/routes/{safe_id}"
    points = fit_path(parse_path(str(line.get("d", ""))))
    stations = list(line.get("stations", []))
    metrics = path_metrics(points)
    color = _rgb(str(line.get("color", "#5cc8ff")))
    scales = RASTER_LEVELS if strategy == "raster-base-segment-atlas" else (1,)
    levels = _build_base_rasters(points, stations, color, output, url_base, scales)
    public_stations = []
    for station in stations:
        anchor = quantized_anchor(point_at_progress(points, float(station.get("progress", 0)), metrics))
        public_stations.append(
            {
                "name": str(station.get("name", "")),
                "pinyin": str(station.get("pinyin", "")),
                "transfer": bool(station.get("transfer", False)),
                "progress": round(float(station.get("progress", 0)), 4),
                "anchor": anchor,
            }
        )
    segments = []
    for index in range(max(0, len(public_stations) - 1)):
        if strategy == "raster-base-segment-atlas":
            segments.append(
                _build_segment_assets(
                    points,
                    float(stations[index].get("progress", 0)),
                    float(stations[index + 1].get("progress", 0)),
                    index,
                    color,
                    output,
                    url_base,
                )
            )
        else:
            segments.append({"from": index, "to": index + 1, "strategy": "quantized-anchor-motion"})
    scene = {
        "id": line_id,
        "name": str(line.get("name", "")),
        "color": str(line.get("color", "#5cc8ff")),
        "terminals": [
            public_stations[0]["name"] if public_stations else "",
            public_stations[-1]["name"] if public_stations else "",
        ],
        "viewport": {"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
        "raster": {"levels": levels},
        "stations": public_stations,
        "segments": segments,
        "motionStrategy": strategy,
        "protection": {
            "schematic": "protected-raster",
            "anchors": f"quantized-{ANCHOR_GRID}px",
        },
    }
    atlas_count = len(segments) * 2 if strategy == "raster-base-segment-atlas" else 0
    return scene, {"rasters": len(levels), "segments": len(segments), "atlases": atlas_count}


def _read_network(path: Path) -> Dict[str, Any]:
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return json.load(handle)
    return json.loads(path.read_text(encoding="utf-8"))


def geographic_index(path: Optional[Path]) -> Dict[str, Dict[str, Any]]:
    if path is None or not path.exists():
        return {}
    network = _read_network(path)
    output: Dict[str, Dict[str, Any]] = {}
    for route in network.get("routes", []):
        route_id = str(route.get("id", ""))
        if route_id:
            output[route_id] = route
        if str(route.get("direction", "forward")) != "forward":
            continue
        route_name = str(route.get("route_no") or route.get("short_name") or "")
        official_id = str(route.get("official_id") or "")
        if official_id.startswith("metro-"):
            line_id = official_id.removeprefix("metro-").replace("-branch", "b")
        else:
            line_id = route_name.replace("号线", "").replace("&", "-").replace("支线", "b").strip()
        gcj02 = route.get("geometry", {}).get("gcj02", {})
        path_points = gcj02.get("path") or []
        if line_id and len(path_points) >= 2:
            output.setdefault(line_id, route)
    return output


def _round_geo_path(points: Iterable[Sequence[float]]) -> List[List[float]]:
    output: List[List[float]] = []
    for point in points:
        rounded = [round(float(point[0]), 5), round(float(point[1]), 5)]
        if not output or rounded != output[-1]:
            output.append(rounded)
    return output


def build_geographic_payload(line: Mapping[str, Any], route: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    path = _round_geo_path(route.get("geometry", {}).get("gcj02", {}).get("path") or [])
    if len(path) < 2:
        return None
    metrics = path_metrics([(point[0], point[1]) for point in path])
    stops = []
    for station in line.get("stations", []):
        progress = round(float(station.get("progress", 0)), 5)
        point = point_at_progress([(item[0], item[1]) for item in path], progress, metrics)
        stops.append(
            {
                "name": str(station.get("name", "")),
                "progress": progress,
                "gcj02": [round(point[0], 5), round(point[1], 5)],
            }
        )
    return {
        "id": str(line.get("id", "")),
        "geometry": {"gcj02": {"path": path}},
        "stops": stops,
        "protection": {"geographic": "derived-vector-quantized-5dp"},
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def build_public_derivatives(
    data: Mapping[str, Any],
    output: Path,
    network_id: str,
    build_id: str,
    geographic_path: Optional[Path] = None,
    strategy: str = "raster-base-segment-atlas",
) -> Dict[str, Any]:
    geographic = geographic_index(geographic_path)
    network_output = output / "networks" / network_id
    manifest_lines: List[Dict[str, Any]] = []
    search_records: Dict[str, Dict[str, Any]] = {}
    counters = {"rasters": 0, "segments": 0, "atlases": 0, "geographic": 0}
    for line in data.get("lines", []):
        line_id = str(line.get("id", ""))
        safe_id = safe_line_id(line_id)
        scene, counts = build_route_scene(line, output, network_id, strategy)
        for key, value in counts.items():
            counters[key] += value
        line_dir = network_output / "lines" / safe_id
        write_json(line_dir / "scene.json", scene)
        source_route_id = str(line.get("sourceRouteId", line_id))
        geo_payload = build_geographic_payload(line, geographic[source_route_id]) if source_route_id in geographic else None
        modes = ["flat"]
        if geo_payload:
            write_json(line_dir / "geographic.json", geo_payload)
            counters["geographic"] += 1
            modes.extend(["animated", "real"])
        stations = list(line.get("stations", []))
        line_ref = {
            "id": line_id,
            "name": str(line.get("name", "")),
            "color": str(line.get("color", "#5cc8ff")),
        }
        manifest_lines.append(
            {
                **line_ref,
                "stationCount": len(stations),
                "terminals": [
                    str(stations[0].get("name", "")) if stations else "",
                    str(stations[-1].get("name", "")) if stations else "",
                ],
                "availableModes": modes,
                "motionStrategy": strategy,
            }
        )
        for station in stations:
            name = str(station.get("name", ""))
            record = search_records.setdefault(
                name,
                {"name": name, "pinyin": str(station.get("pinyin", "")), "lines": []},
            )
            if all(item["id"] != line_id for item in record["lines"]):
                record["lines"].append(line_ref)
    manifest = {
        "id": network_id,
        "name": str(data.get("name") or network_id),
        "version": data.get("mapVersion"),
        "buildId": build_id,
        "protection": {
            "schematic": "protected-raster",
            "geographic": "derived-vector",
            "overview": "protected-raster",
            "metadata": "public",
        },
        "lines": manifest_lines,
    }
    write_json(network_output / "manifest.json", manifest)
    write_json(network_output / "search-index.json", {"stations": list(search_records.values())})
    return {**counters, "lines": len(manifest_lines), "searchStations": len(search_records)}


def audit_public_bundle(root: Path) -> List[str]:
    """Return safety violations found in a generated public deployment bundle."""

    violations: List[str] = []
    if not root.exists():
        return ["公开部署目录不存在"]
    forbidden_names = {"zhanyue_metro_data.json", "metro_schematic_layout.json", "review"}
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if any(part in forbidden_names for part in relative.parts):
            violations.append(f"禁止文件或目录：{relative}")
        if not path.is_file():
            continue
        if path.suffix in {".html", ".js", ".json"}:
            text = path.read_text(encoding="utf-8")
            if "let DATA =" in text or "导出校核 JSON" in text:
                violations.append(f"包含内部运行时或校核入口：{relative}")
        if path.name == "scene.json":
            payload = json.loads(path.read_text(encoding="utf-8"))
            serialized = json.dumps(payload, ensure_ascii=False)
            for forbidden_key in ('"d"', '"points"', '"bbox"', '"x"', '"y"'):
                if forbidden_key in serialized:
                    violations.append(f"场景包含精确几何字段 {forbidden_key}：{relative}")
    return violations
