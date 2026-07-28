"""Build one hardened public application directly from generated networks.

Exact network and optional hand-tuned layout data are read only by this
trusted build step.  The resulting bundle contains protected rasters,
quantized station anchors and separately quantized geographic derivatives.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import math
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

from ..common.language import StationLanguageStore
from ..networks.bus.config import NETWORK_PATH as BUS_NETWORK
from ..networks.bus.matcher import normalize_stop
from ..networks.metro.config import LAYOUT_PATH as METRO_LAYOUT
from ..networks.metro.config import NETWORK_PATH as METRO_NETWORK
from ..networks.metro.matcher import normalize_name
from ..settings import LANGUAGE_PATH, PUBLIC_DIR, WEB_DIR
from .public_assets import audit_public_bundle, build_public_derivatives, safe_line_id, write_json
from .schematic import build_schematic_network, point_at_progress


Point = Tuple[float, float]
BUILD_FORMAT_VERSION = "transit-public-1"
STRATEGIES = {
    "bus": "raster-base-coarse-motion",
    "metro": "raster-base-segment-atlas",
}


def _read_network(path: Path) -> Tuple[Dict[str, Any], bytes]:
    if not path.is_file():
        raise RuntimeError("找不到线网构建结果：{}".format(path))
    raw = path.read_bytes()
    try:
        if path.suffix == ".gz":
            with gzip.open(str(path), "rt", encoding="utf-8") as handle:
                payload = json.load(handle)
        else:
            payload = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("线网构建结果损坏：{}".format(path)) from exc
    if not isinstance(payload, dict) or not payload.get("routes"):
        raise RuntimeError("线网构建结果没有 routes：{}".format(path))
    return payload, raw


def _path_d(points: Sequence[Sequence[float]]) -> str:
    if len(points) < 2:
        raise ValueError("公开线路至少需要两个路径点")
    return " ".join(
        "{} {:.2f} {:.2f}".format("M" if index == 0 else "L", float(point[0]), float(point[1]))
        for index, point in enumerate(points)
    )


def _stable_color(value: object) -> str:
    digest = hashlib.sha256(str(value).encode("utf-8")).digest()
    hue = int.from_bytes(digest[:2], "big") % 360
    saturation = 68 + digest[2] % 15
    lightness = 50 + digest[3] % 10
    chroma = (1 - abs(2 * lightness / 100 - 1)) * saturation / 100
    segment = (hue / 60) % 2
    x = chroma * (1 - abs(segment % 2 - 1))
    values = [(chroma, x, 0), (x, chroma, 0), (0, chroma, x), (0, x, chroma), (x, 0, chroma), (chroma, 0, x)]
    red, green, blue = values[min(5, hue // 60)]
    offset = lightness / 100 - chroma / 2
    return "#{:02x}{:02x}{:02x}".format(
        round((red + offset) * 255), round((green + offset) * 255), round((blue + offset) * 255)
    )


def _language_record(store: StationLanguageStore, name: str) -> Dict[str, str]:
    record = store.get(name)
    return {
        "pinyin": str(record.get("pinyin", "")),
        "reviewNote": str(record.get("note", "")),
        "audioUrl": str(record.get("audio_url", "")),
    }


def _bus_public_data(network: Dict[str, Any], language: StationLanguageStore) -> Dict[str, Any]:
    transfer_counts: Dict[str, int] = {}
    for station in network.get("stations", []):
        key = normalize_stop(str(station.get("name", "")))
        transfer_counts[key] = max(transfer_counts.get(key, 1), int(station.get("route_count", 1)))
    lines = []
    for route in network.get("routes", []):
        path = route.get("paths", {}).get("medium") or route.get("paths", {}).get("detail", [])
        stops = route.get("stops", [])
        if len(path) < 2 or len(stops) < 2:
            continue
        public_id = "bus-{}".format(safe_line_id(route.get("id", "")))
        stations = []
        previous = 0.0
        for index, stop in enumerate(stops):
            progress = max(previous, min(1.0, float(stop.get("progress", index / max(1, len(stops) - 1)))))
            if index == len(stops) - 1:
                progress = 1.0
            previous = progress
            name = str(stop.get("name", ""))
            line_count = transfer_counts.get(normalize_stop(name), 1)
            stations.append(
                {
                    "name": name,
                    "progress": round(progress, 6),
                    "transfer": line_count > 1,
                    "lineCount": line_count,
                    **_language_record(language, name),
                }
            )
        lines.append(
            {
                "id": public_id,
                "sourceRouteId": str(route.get("id", "")),
                "name": "{} · {}".format(route.get("route_no", ""), route.get("direction_label", "")),
                "color": _stable_color(route.get("route_no", route.get("id"))),
                "d": _path_d(path),
                "stations": stations,
            }
        )
    return {
        "name": "深圳公交站名挑战",
        "mapVersion": network.get("built_at", ""),
        "sourceDate": network.get("built_at", ""),
        "lines": lines,
    }


def _apply_metro_layout(network: Dict[str, Any], layout_path: Path) -> None:
    if not layout_path.is_file():
        return
    try:
        layout = json.loads(layout_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    line_overrides = layout.get("lines", {})
    for route in network.get("routes", []):
        override = line_overrides.get(route.get("id"))
        schematic = route.get("schematic")
        if not override or not schematic:
            continue
        schematic["path"] = override.get("path", schematic.get("path"))
        schematic["station_progress"] = override.get("station_progress", schematic.get("station_progress"))
    for key, override in layout.get("anchors", {}).items():
        anchor = (network.get("transfer_anchors") or {}).get(key)
        if anchor and isinstance(override, dict):
            anchor["x"] = override.get("x", anchor.get("x"))
            anchor["y"] = override.get("y", anchor.get("y"))


def _projection(routes: Sequence[Mapping[str, Any]]) -> Any:
    points = [point for route in routes for point in route.get("schematic", {}).get("path", [])]
    if not points:
        raise RuntimeError("地铁线网没有可发布示意几何")
    min_x = min(float(point[0]) for point in points)
    max_x = max(float(point[0]) for point in points)
    min_y = min(float(point[1]) for point in points)
    max_y = max(float(point[1]) for point in points)
    usable_width, usable_height = 1180.0, 565.0
    scale = min(usable_width / max(1.0, max_x - min_x), usable_height / max(1.0, max_y - min_y))
    offset_x = 50.0 + (usable_width - (max_x - min_x) * scale) / 2
    offset_y = 75.0 + (usable_height - (max_y - min_y) * scale) / 2

    def project(point: Sequence[float]) -> Point:
        return offset_x + (float(point[0]) - min_x) * scale, offset_y + (float(point[1]) - min_y) * scale

    return project


def _metro_public_data(network: Dict[str, Any], language: StationLanguageStore) -> Dict[str, Any]:
    if "transfer_anchors" not in network:
        network["routes"] = [dict(route) for route in network.get("routes", [])]
        build_schematic_network(network)
    _apply_metro_layout(network, METRO_LAYOUT)
    routes = [route for route in network.get("routes", []) if route.get("direction") == "forward"]
    project = _projection(routes)
    anchors = network.get("transfer_anchors") or {}
    lines = []
    for route in routes:
        schematic = route.get("schematic") or {}
        path = schematic.get("path", [])
        stops = route.get("stops", [])
        progresses = schematic.get("station_progress", [])
        if len(path) < 2 or len(stops) < 2:
            continue
        stations = []
        previous = 0.0
        for index, stop in enumerate(stops):
            progress = float(progresses[index]) if index < len(progresses) else index / max(1, len(stops) - 1)
            progress = max(previous, min(1.0, progress))
            if index == len(stops) - 1:
                progress = 1.0
            previous = progress
            name = str(stop.get("name", ""))
            anchor = anchors.get(normalize_name(name), {})
            line_count = max(1, len(anchor.get("lines", [])))
            stations.append(
                {
                    "name": name,
                    "progress": round(progress, 6),
                    "transfer": line_count > 1,
                    "lineCount": line_count,
                    **_language_record(language, name),
                }
            )
        lines.append(
            {
                "id": "metro-{}".format(safe_line_id(route.get("short_name") or route.get("id", ""))),
                "sourceRouteId": str(route.get("id", "")),
                "name": str(route.get("route_no", "")),
                "color": str(route.get("color", "#5cc8ff")),
                "d": _path_d([project(point) for point in path]),
                "stations": stations,
            }
        )
    return {
        "name": "深圳地铁站名挑战",
        "mapVersion": network.get("built_at", ""),
        "sourceDate": network.get("built_at", ""),
        "lines": lines,
    }


def build_public_data(network_id: str) -> Tuple[Dict[str, Any], Path, bytes]:
    language = StationLanguageStore(LANGUAGE_PATH)
    if network_id == "bus":
        network, raw = _read_network(BUS_NETWORK)
        return _bus_public_data(network, language), BUS_NETWORK, raw
    if network_id == "metro":
        network, raw = _read_network(METRO_NETWORK)
        return _metro_public_data(network, language), METRO_NETWORK, raw
    raise ValueError("不支持的网络：{}".format(network_id))


def _font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).is_file():
            try:
                return ImageFont.truetype(candidate, size=size, index=0)
            except OSError:
                continue
    return ImageFont.load_default()


_PATH_TOKEN = re.compile(r"[ML]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?", re.IGNORECASE)


def _parse_path(value: str) -> List[Point]:
    tokens = _PATH_TOKEN.findall(value)
    output = []
    for index in range(0, len(tokens), 3):
        if index + 2 < len(tokens) and tokens[index].upper() in {"M", "L"}:
            output.append((float(tokens[index + 1]), float(tokens[index + 2])))
    return output


def _overview_image(data: Mapping[str, Any], output: Path, build_id: str) -> None:
    width, height = 1920, 1080
    image = Image.new("RGB", (width, height), "#07101d")
    draw = ImageDraw.Draw(image, "RGBA")
    parsed = [(line, _parse_path(str(line.get("d", "")))) for line in data.get("lines", [])]
    points = [point for line, path in parsed for point in path]
    if not points:
        raise RuntimeError("{} 没有可绘制公开线路".format(data.get("name", "网络")))
    min_x, max_x = min(point[0] for point in points), max(point[0] for point in points)
    min_y, max_y = min(point[1] for point in points), max(point[1] for point in points)
    scale = min(1580 / max(1, max_x - min_x), 840 / max(1, max_y - min_y))
    offset_x = 170 + (1580 - (max_x - min_x) * scale) / 2
    offset_y = 120 + (840 - (max_y - min_y) * scale) / 2

    def project(point: Point) -> Tuple[int, int]:
        return round(offset_x + (point[0] - min_x) * scale), round(offset_y + (point[1] - min_y) * scale)

    for x in range(0, width, 96):
        draw.line([(x, 0), (x, height)], fill=(145, 185, 220, 11), width=1)
    for y in range(0, height, 96):
        draw.line([(0, y), (width, y)], fill=(145, 185, 220, 11), width=1)
    for line, path in parsed:
        if len(path) < 2:
            continue
        projected = [project(point) for point in path]
        color = str(line.get("color", "#5cc8ff"))
        try:
            rgb = tuple(int(color.lstrip("#")[index : index + 2], 16) for index in (0, 2, 4))
        except ValueError:
            rgb = (92, 200, 255)
        draw.line(projected, fill=(1, 7, 13, 220), width=10, joint="curve")
        draw.line(projected, fill=rgb + (150,), width=5, joint="curve")
    draw.text((80, 66), str(data.get("name", "深圳交通")), font=_font(34, True), fill=(238, 247, 255, 235))
    draw.text((80, height - 58), "公开派生栅格 · 非官方产品 · build {}".format(build_id[-8:]), font=_font(18), fill=(126, 178, 216, 210))
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("BuildId", build_id)
    metadata.add_text("Protection", "Derived raster; precise source geometry excluded from bundle")
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, format="PNG", optimize=True, pnginfo=metadata)


def _minify_css(css: str) -> str:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    css = re.sub(r"\s+", " ", css)
    return re.sub(r"\s*([{}:;,>])\s*", r"\1", css).strip()


def _build_shell(output: Path, build_id: str) -> Dict[str, Any]:
    source = WEB_DIR / "public"
    template = (source / "index.template.html").read_text(encoding="utf-8")
    css = _minify_css((source / "app.css").read_text(encoding="utf-8"))
    modules = sorted((source / "modules").glob("*.js"))
    bundle = "\n".join(path.read_text(encoding="utf-8") for path in modules).replace("</script", "<\\/script")
    script_hash = base64.b64encode(hashlib.sha256(bundle.encode("utf-8")).digest()).decode("ascii")
    csp = (
        "default-src 'self'; img-src 'self' data: https://*.amap.com; "
        "style-src 'self' 'unsafe-inline' https://*.amap.com; "
        "script-src 'sha256-{}' blob: https://webapi.amap.com https://*.amap.com; "
        "connect-src 'self' https://*.amap.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    ).format(script_hash)
    html = template.replace("__TRANSIT_BUILD_ID__", build_id)
    html = html.replace("__TRANSIT_CSP__", csp)
    html = html.replace("__TRANSIT_CSS__", css)
    html = html.replace("__TRANSIT_BOOTSTRAP__", bundle)
    (output / "index.html").write_text(html, encoding="utf-8")
    return {"bytes": len(html.encode("utf-8")), "modules": len(modules)}


def publish_public(networks: Sequence[str], output: Path = PUBLIC_DIR) -> Dict[str, Any]:
    selected = []
    for network_id in networks:
        if network_id not in {"bus", "metro"}:
            raise ValueError("不支持的网络：{}".format(network_id))
        if network_id not in selected:
            selected.append(network_id)
    if not selected:
        raise ValueError("至少选择一个网络")
    prepared = []
    fingerprint = hashlib.sha256(BUILD_FORMAT_VERSION.encode("ascii"))
    for network_id in selected:
        data, network_path, raw = build_public_data(network_id)
        prepared.append((network_id, data, network_path))
        fingerprint.update(network_id.encode("ascii"))
        fingerprint.update(raw)
        # Language overrides and the trusted metro layout are already reflected
        # in ``data``. Include the complete prepared input so every observable
        # public change receives a new immutable asset build id.
        fingerprint.update(
            json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        )
    for path in sorted((WEB_DIR / "public").rglob("*")):
        if path.is_file():
            fingerprint.update(path.relative_to(WEB_DIR).as_posix().encode("utf-8"))
            fingerprint.update(path.read_bytes())
    build_id = "public-{}".format(fingerprint.hexdigest()[:16])
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="transit-public-", dir=str(output.parent)) as directory:
        staging = Path(directory) / "public"
        staging.mkdir(parents=True)
        shell = _build_shell(staging, build_id)
        network_entries = []
        results: Dict[str, Any] = {}
        for network_id, data, network_path in prepared:
            strategy = STRATEGIES[network_id]
            _overview_image(data, staging / "assets" / network_id / "network-overview.png", build_id)
            derivatives = build_public_derivatives(
                data,
                staging,
                network_id,
                build_id,
                geographic_path=network_path,
                strategy=strategy,
            )
            network_entries.append(
                {
                    "id": network_id,
                    "name": data["name"],
                    "manifest": "/api/{}/manifest".format(network_id),
                    "overview": "/assets/{}/network-overview.png".format(network_id),
                }
            )
            results[network_id] = {"strategy": strategy, **derivatives}
        write_json(
            staging / "networks.json",
            {
                "edition": "public",
                "buildId": build_id,
                "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "networks": network_entries,
            },
        )
        violations = audit_public_bundle(staging)
        if violations:
            raise RuntimeError("公开构建审计失败：\n- " + "\n- ".join(violations))
        if output.exists():
            shutil.rmtree(output)
        shutil.move(str(staging), str(output))
    return {
        "buildId": build_id,
        "output": str(output),
        "shell": shell,
        "networks": results,
        "audit": "passed",
    }
