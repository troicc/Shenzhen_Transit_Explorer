"""Validated migration from the historical Zhanyue single-file prototype.

The HTML is accepted only as an import source.  Its data is mapped to the
canonical Metro network and emitted as revisionable layout/language/review
artifacts; the HTML never becomes a runtime dependency.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import re
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .schematic import point_at_progress
from ..networks.metro.matcher import normalize_name


Point = List[float]
_DATA_ASSIGNMENT = re.compile(r"\b(?:let|const|var)\s+DATA\s*=", re.MULTILINE)
_PATH_TOKEN = re.compile(
    r"[MmLlHhVvZz]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
)


class ZhanyueImportError(ValueError):
    def __init__(self, message: str, report: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.report = report or {}


def extract_zhanyue_data(html: str) -> Dict[str, Any]:
    match = _DATA_ASSIGNMENT.search(html)
    if not match:
        raise ZhanyueImportError("附件 HTML 中没有找到 let DATA = {...}")
    try:
        payload, _ = json.JSONDecoder().raw_decode(html[match.end() :].lstrip())
    except json.JSONDecodeError as exc:
        raise ZhanyueImportError("附件 HTML 中的 DATA 不是有效 JSON：{}".format(exc)) from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("lines"), list):
        raise ZhanyueImportError("附件 HTML 的 DATA 缺少 lines")
    return payload


def parse_svg_path(value: str) -> List[Point]:
    source = str(value or "").strip()
    if not source:
        raise ZhanyueImportError("SVG path d 不能为空")
    tokens: List[str] = []
    cursor = 0
    for match in _PATH_TOKEN.finditer(source):
        if source[cursor : match.start()].strip(" ,\t\r\n"):
            raise ZhanyueImportError("SVG path 含不支持的命令")
        tokens.append(match.group(0))
        cursor = match.end()
    if source[cursor:].strip(" ,\t\r\n"):
        raise ZhanyueImportError("SVG path 含不支持的命令")

    points: List[Point] = []
    command: Optional[str] = None
    current = [0.0, 0.0]
    subpath_start = [0.0, 0.0]
    index = 0

    def number(position: int) -> float:
        if position >= len(tokens) or tokens[position].isalpha():
            raise ZhanyueImportError("SVG path 命令缺少坐标")
        result = float(tokens[position])
        if not math.isfinite(result):
            raise ZhanyueImportError("SVG path 坐标不是有限数字")
        return result

    def append(point: Sequence[float]) -> None:
        normalized = [float(point[0]), float(point[1])]
        if not points or points[-1] != normalized:
            points.append(normalized)

    while index < len(tokens):
        token = tokens[index]
        if token.isalpha():
            command = token
            index += 1
            if command in "Zz":
                append(subpath_start)
                current = list(subpath_start)
                command = None
                continue
        if command is None:
            raise ZhanyueImportError("SVG path 坐标前缺少命令")
        relative = command.islower()
        upper = command.upper()
        if upper in {"M", "L"}:
            x = number(index)
            y = number(index + 1)
            index += 2
            if relative:
                x += current[0]
                y += current[1]
            current = [x, y]
            append(current)
            if upper == "M":
                subpath_start = list(current)
                command = "l" if relative else "L"
        elif upper == "H":
            x = number(index)
            index += 1
            current = [current[0] + x if relative else x, current[1]]
            append(current)
        elif upper == "V":
            y = number(index)
            index += 1
            current = [current[0], current[1] + y if relative else y]
            append(current)
        else:
            raise ZhanyueImportError("SVG path 仅支持 M/L/H/V/Z 命令")
    if len(points) < 2:
        raise ZhanyueImportError("SVG path 至少需要两个不同的点")
    return points


def _load_network(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        raise ZhanyueImportError("地铁线网不存在：{}".format(path))
    opener = gzip.open if path.suffix == ".gz" else open
    try:
        with opener(str(path), "rt", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ZhanyueImportError("地铁线网无法读取：{}".format(exc)) from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("routes"), list):
        raise ZhanyueImportError("地铁线网缺少 routes")
    return payload


def _canonical_line_key(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    digits = re.findall(r"\d+", text)
    if not digits:
        return re.sub(r"[^\w]+", "", text)
    if "支" in text or re.fullmatch(r"\d+b", text):
        return "{}支".format(digits[0])
    if len(digits) > 1:
        return "-".join(digits)
    return digits[0]


def _logical_route_key(route: Mapping[str, Any]) -> str:
    short_name = str(route.get("short_name") or "").strip()
    if short_name:
        return short_name
    official_id = str(route.get("official_id") or "").removeprefix("metro-")
    return official_id or str(route.get("id") or "").split(":", 1)[0].removeprefix("metro-")


def _route_keys(route: Mapping[str, Any]) -> set[str]:
    return {
        _canonical_line_key(route.get("short_name")),
        _canonical_line_key(route.get("route_no")),
        _canonical_line_key(route.get("official_id")),
        _canonical_line_key(route.get("id")),
    } - {""}


def _source_keys(line: Mapping[str, Any], line_map: Mapping[str, str]) -> set[str]:
    source_id = str(line.get("id") or "")
    explicit = line_map.get(source_id)
    if explicit:
        return {_canonical_line_key(explicit)}
    return {
        _canonical_line_key(source_id),
        _canonical_line_key(line.get("name")),
    } - {""}


def _normalized_station_names(stops: Iterable[Mapping[str, Any]], key: str = "name") -> List[str]:
    return [normalize_name(str(stop.get(key) or "")) for stop in stops]


def _progresses(stations: Sequence[Mapping[str, Any]], line_name: str) -> List[float]:
    if len(stations) < 2:
        raise ZhanyueImportError("线路 {} 少于两个站点".format(line_name))
    output: List[float] = []
    previous = -1.0
    for station in stations:
        try:
            value = float(station.get("progress"))
        except (TypeError, ValueError) as exc:
            raise ZhanyueImportError("线路 {} 含无效 progress".format(line_name)) from exc
        if not math.isfinite(value) or value < 0 or value > 1 or value + 1e-9 < previous:
            raise ZhanyueImportError("线路 {} 的 progress 必须单调且位于 0 到 1".format(line_name))
        output.append(max(previous, value))
        previous = output[-1]
    if output[0] > 1e-6 or output[-1] < 1 - 1e-6:
        raise ZhanyueImportError("线路 {} 的 progress 必须覆盖 0 到 1".format(line_name))
    output[0] = 0.0
    output[-1] = 1.0
    return output


def _transform_paths(paths: Sequence[List[Point]], world: Mapping[str, Any]) -> Tuple[List[List[Point]], Dict[str, Any]]:
    all_points = [point for path in paths for point in path]
    min_x = min(point[0] for point in all_points)
    min_y = min(point[1] for point in all_points)
    max_x = max(point[0] for point in all_points)
    max_y = max(point[1] for point in all_points)
    source_width = max_x - min_x
    source_height = max_y - min_y
    try:
        target_width = float(world.get("width"))
        target_height = float(world.get("height"))
    except (TypeError, ValueError) as exc:
        raise ZhanyueImportError("地铁线网 world 尺寸无效") from exc
    if min(source_width, source_height, target_width, target_height) <= 0:
        raise ZhanyueImportError("附件或地铁线网的世界尺寸无效")
    scale_x = target_width / source_width
    scale_y = target_height / source_height
    skew = abs(scale_x - scale_y) / max(scale_x, scale_y)
    if skew > 0.05:
        raise ZhanyueImportError("附件几何与当前线网 world 的纵横比例不一致")
    scale = (scale_x + scale_y) / 2
    offset_x = (target_width - source_width * scale) / 2 - min_x * scale
    offset_y = (target_height - source_height * scale) / 2 - min_y * scale
    transformed = [
        [[round(point[0] * scale + offset_x, 6), round(point[1] * scale + offset_y, 6)] for point in path]
        for path in paths
    ]
    return transformed, {
        "sourceBounds": [min_x, min_y, max_x, max_y],
        "targetWorld": [target_width, target_height],
        "scale": scale,
        "offset": [offset_x, offset_y],
        "aspectSkew": skew,
    }


def _clean_language_value(field: str, value: Any) -> str:
    text = str(value or "").strip()
    if field == "pinyin":
        return re.sub(r"\s+", " ", text.lower())
    return text


def _atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def build_zhanyue_import(
    html_path: Path,
    network_path: Path,
    *,
    line_map: Optional[Mapping[str, str]] = None,
    imported_at: Optional[str] = None,
) -> Dict[str, Any]:
    html_path = Path(html_path)
    network_path = Path(network_path)
    try:
        source_bytes = html_path.read_bytes()
        html = source_bytes.decode("utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        raise ZhanyueImportError("附件 HTML 无法读取：{}".format(exc)) from exc
    payload = extract_zhanyue_data(html)
    network = _load_network(network_path)
    timestamp = imported_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    mapping_overrides = {str(key): str(value) for key, value in (line_map or {}).items()}
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    report: Dict[str, Any] = {
        "version": 1,
        "source": {
            "filename": html_path.name,
            "sha256": source_hash,
            "sourceDate": payload.get("sourceDate"),
            "mapVersion": payload.get("mapVersion"),
            "geometryPass": payload.get("geometryPass"),
            "importedAt": timestamp,
        },
        "lineMappings": [],
        "languageConflicts": [],
        "anchorConflicts": [],
    }

    parsed_lines: List[Dict[str, Any]] = []
    for raw_line in payload.get("lines", []):
        if not isinstance(raw_line, Mapping) or not isinstance(raw_line.get("stations"), list):
            raise ZhanyueImportError("附件 lines 含无效线路", report)
        name = str(raw_line.get("name") or raw_line.get("id") or "未命名线路")
        stations = raw_line["stations"]
        parsed_lines.append(
            {
                "raw": raw_line,
                "path": parse_svg_path(str(raw_line.get("d") or "")),
                "progresses": _progresses(stations, name),
                "stations": stations,
            }
        )

    forward_routes = [route for route in network.get("routes", []) if route.get("direction") == "forward"]
    mapped: List[Dict[str, Any]] = []
    for parsed in parsed_lines:
        raw_line = parsed["raw"]
        source_names = _normalized_station_names(parsed["stations"])
        wanted = _source_keys(raw_line, mapping_overrides)
        keyed = [route for route in forward_routes if wanted & _route_keys(route)]
        exact = [route for route in keyed if _normalized_station_names(route.get("stops", [])) == source_names]
        method = "line-key-and-stations"
        if not exact and not keyed:
            exact = [
                route for route in forward_routes
                if _normalized_station_names(route.get("stops", [])) == source_names
            ]
            method = "station-sequence-fallback"
        entry = {
            "sourceId": str(raw_line.get("id") or ""),
            "sourceName": str(raw_line.get("name") or ""),
            "stationCount": len(source_names),
            "start": parsed["stations"][0].get("name"),
            "end": parsed["stations"][-1].get("name"),
        }
        if len(exact) == 1:
            route = exact[0]
            entry.update(
                {
                    "status": "mapped",
                    "method": method,
                    "routeId": route.get("id"),
                    "logicalLineId": _logical_route_key(route),
                }
            )
            mapped.append({**parsed, "route": route, "logical": _logical_route_key(route)})
        else:
            entry.update(
                {
                    "status": "conflict" if keyed or len(exact) > 1 else "unmapped",
                    "reason": (
                        "站序与同名 forward route 不一致"
                        if keyed and not exact
                        else "存在多个完全匹配线路" if len(exact) > 1 else "找不到匹配线路"
                    ),
                    "candidates": [route.get("id") for route in (exact or keyed)],
                }
            )
        report["lineMappings"].append(entry)

    source_line_count = len(parsed_lines)
    if len(mapped) != source_line_count:
        report["summary"] = {
            "sourceLines": source_line_count,
            "mappedLines": len(mapped),
            "ok": False,
        }
        report["ok"] = False
        raise ZhanyueImportError("附件线路未能全部明确映射", report)

    transformed, transform = _transform_paths([item["path"] for item in mapped], network.get("world") or {})
    report["transform"] = transform
    for item, path in zip(mapped, transformed):
        item["layoutPath"] = path

    layout_lines: Dict[str, Any] = {}
    language_occurrences: Dict[str, List[Dict[str, Any]]] = {}
    review_items: Dict[str, Any] = {}
    known_anchors = network.get("transfer_anchors") or {}
    anchor_samples: Dict[str, List[Dict[str, Any]]] = {}

    for item in mapped:
        logical = item["logical"]
        route_stops = item["route"].get("stops", [])
        layout_lines[logical] = {
            "path": item["layoutPath"],
            "station_progress": item["progresses"],
        }
        for index, (source_station, route_stop) in enumerate(zip(item["stations"], route_stops)):
            name = str(route_stop.get("name") or source_station.get("name") or "").strip()
            occurrence = {
                "line": logical,
                "pinyin": source_station.get("pinyin"),
                "audio_url": source_station.get("audioUrl"),
                "note": source_station.get("reviewNote"),
            }
            language_occurrences.setdefault(name, []).append(occurrence)
            review_items["{}:{}".format(logical, name)] = {
                "status": str(source_station.get("reviewStatus") or "unreviewed")[:40],
                "note": str(source_station.get("reviewNote") or "")[:1000],
                "updatedAt": timestamp,
            }
            anchor_key = normalize_name(name)
            if anchor_key in known_anchors:
                point = point_at_progress(item["layoutPath"], item["progresses"][index])
                anchor_samples.setdefault(anchor_key, []).append(
                    {"line": logical, "point": [float(point[0]), float(point[1])]}
                )

    language_stations: Dict[str, Dict[str, str]] = {}
    for name, occurrences in sorted(language_occurrences.items()):
        output: Dict[str, str] = {}
        for field in ("pinyin", "audio_url", "note"):
            values: List[str] = []
            for occurrence in occurrences:
                value = _clean_language_value(field, occurrence.get(field))
                if value and value not in values:
                    values.append(value)
            if values:
                output[field] = values[0]
            if len(values) > 1:
                report["languageConflicts"].append(
                    {
                        "station": name,
                        "field": field,
                        "values": values,
                        "lines": [occurrence["line"] for occurrence in occurrences],
                    }
                )
        if output:
            language_stations[name] = output

    layout_anchors: Dict[str, Dict[str, float]] = {}
    tolerance = max(2.0, max(transform["targetWorld"]) * 0.0025)
    for key, samples in sorted(anchor_samples.items()):
        x = sum(sample["point"][0] for sample in samples) / len(samples)
        y = sum(sample["point"][1] for sample in samples) / len(samples)
        spread = max(math.hypot(sample["point"][0] - x, sample["point"][1] - y) for sample in samples)
        layout_anchors[key] = {"x": round(x, 6), "y": round(y, 6)}
        if spread > tolerance:
            report["anchorConflicts"].append(
                {"anchorKey": key, "spread": spread, "tolerance": tolerance, "samples": samples}
            )

    source_metadata = {
        "format": "zhanyue-v3",
        "sha256": source_hash,
        "mapVersion": str(payload.get("mapVersion") or ""),
        "sourceDate": str(payload.get("sourceDate") or ""),
        "importedAt": timestamp,
    }
    layout = {
        "key_version": 2,
        "alpha": float(network.get("schematic_alpha", 0.55) or 0.55),
        "source": source_metadata,
        "lines": layout_lines,
        "anchors": layout_anchors,
    }
    language = {"version": 2, "stations": language_stations}
    review = {"version": 1, "items": dict(sorted(review_items.items()))}
    report["missingAnchors"] = sorted(set(known_anchors) - set(layout_anchors))
    report["summary"] = {
        "sourceLines": source_line_count,
        "mappedLines": len(mapped),
        "sourceStationRecords": sum(len(item["stations"]) for item in mapped),
        "uniqueStations": len(language_occurrences),
        "layoutAnchors": len(layout_anchors),
        "languageConflicts": len(report["languageConflicts"]),
        "anchorConflicts": len(report["anchorConflicts"]),
        "ok": not report["anchorConflicts"],
    }
    report["ok"] = report["summary"]["ok"]
    if report["anchorConflicts"]:
        raise ZhanyueImportError("附件中的换乘锚点几何存在冲突", report)
    return {"layout": layout, "language": language, "review": review, "report": report}


def write_import_bundle(bundle: Mapping[str, Any], output_dir: Path) -> Dict[str, str]:
    output_dir = Path(output_dir)
    paths = {
        "layout": output_dir / "layout.json",
        "language": output_dir / "language.json",
        "review": output_dir / "review.json",
        "report": output_dir / "report.json",
    }
    for key, path in paths.items():
        _atomic_json(path, bundle[key])
    return {key: str(path) for key, path in paths.items()}


def _read_object(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def apply_import_bundle(
    bundle: Mapping[str, Any],
    *,
    layout_path: Path,
    language_path: Path,
    review_path: Path,
) -> Dict[str, Any]:
    """Apply explicitly, preserving existing manual language/review decisions."""

    existing_language = _read_object(language_path)
    merged_language = dict(existing_language.get("stations") or {})
    preserved: List[Dict[str, str]] = []
    for name, imported in (bundle["language"].get("stations") or {}).items():
        current = dict(merged_language.get(name) or {})
        for field, value in imported.items():
            if str(current.get(field) or "").strip() and current.get(field) != value:
                preserved.append({"station": name, "field": field})
            else:
                current[field] = value
        merged_language[name] = current

    existing_review = _read_object(review_path)
    merged_review = dict(existing_review.get("items") or {})
    for key, imported in (bundle["review"].get("items") or {}).items():
        if key not in merged_review:
            merged_review[key] = imported

    _atomic_json(layout_path, bundle["layout"])
    _atomic_json(language_path, {"version": 2, "stations": dict(sorted(merged_language.items()))})
    _atomic_json(review_path, {"version": 1, "items": dict(sorted(merged_review.items()))})
    return {
        "layout": str(layout_path),
        "language": str(language_path),
        "review": str(review_path),
        "preservedManualLanguageFields": preserved,
    }
