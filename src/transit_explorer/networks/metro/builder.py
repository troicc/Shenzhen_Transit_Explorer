from __future__ import annotations

import argparse
import gzip
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .config import DATA_DIR, DB_PATH, NETWORK_PATH
from .db import selected_routes
from .matcher import normalize_name, similarity
from ...features.schematic import build_schematic_network

Point = Tuple[float, float]
WORLD_WIDTH = 10000.0


def mercator(lng: float, lat: float) -> Point:
    latitude = max(-85.0, min(85.0, float(lat)))
    x = math.radians(float(lng))
    y = math.log(math.tan(math.pi / 4.0 + math.radians(latitude) / 2.0))
    return x, y


def inverse_mercator(x: float, y: float) -> Point:
    """Convert the builder's Mercator coordinates back to GCJ-02 degrees."""

    return math.degrees(float(x)), math.degrees(2.0 * math.atan(math.exp(float(y))) - math.pi / 2.0)


def point_segment_distance_sq(point: Point, start: Point, end: Point) -> Tuple[float, float, Point]:
    px, py = point
    ax, ay = start
    bx, by = end
    dx = bx - ax
    dy = by - ay
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-18:
        return (px - ax) ** 2 + (py - ay) ** 2, 0.0, start
    t = ((px - ax) * dx + (py - ay) * dy) / length_sq
    t = max(0.0, min(1.0, t))
    projected = (ax + dx * t, ay + dy * t)
    return (px - projected[0]) ** 2 + (py - projected[1]) ** 2, t, projected


def cumulative_lengths(path: Sequence[Point]) -> List[float]:
    lengths = [0.0]
    for index in range(1, len(path)):
        dx = path[index][0] - path[index - 1][0]
        dy = path[index][1] - path[index - 1][1]
        lengths.append(lengths[-1] + math.hypot(dx, dy))
    return lengths


def project_point_to_path(point: Point, path: Sequence[Point], lengths: Sequence[float]) -> Tuple[float, Point]:
    if len(path) < 2:
        return 0.0, path[0]
    total = lengths[-1] or 1.0
    best_distance = float("inf")
    best_progress = 0.0
    best_point = path[0]
    for index in range(1, len(path)):
        distance, t, projected = point_segment_distance_sq(point, path[index - 1], path[index])
        if distance < best_distance:
            segment_length = lengths[index] - lengths[index - 1]
            best_distance = distance
            best_progress = (lengths[index - 1] + segment_length * t) / total
            best_point = projected
    return max(0.0, min(1.0, best_progress)), best_point


def point_at_progress(path: Sequence[Point], lengths: Sequence[float], progress: float) -> Point:
    progress = max(0.0, min(1.0, progress))
    if len(path) < 2:
        return path[0]
    target = progress * lengths[-1]
    for index in range(1, len(lengths)):
        if lengths[index] >= target:
            segment = lengths[index] - lengths[index - 1]
            ratio = 0.0 if segment <= 1e-18 else (target - lengths[index - 1]) / segment
            return (
                path[index - 1][0] + (path[index][0] - path[index - 1][0]) * ratio,
                path[index - 1][1] + (path[index][1] - path[index - 1][1]) * ratio,
            )
    return path[-1]


def perpendicular_distance(point: Point, start: Point, end: Point) -> float:
    return math.sqrt(point_segment_distance_sq(point, start, end)[0])


def simplify(points: Sequence[Point], tolerance: float) -> List[Point]:
    if len(points) <= 2:
        return list(points)
    first = points[0]
    last = points[-1]
    maximum = 0.0
    selected = -1
    for index in range(1, len(points) - 1):
        distance = perpendicular_distance(points[index], first, last)
        if distance > maximum:
            maximum = distance
            selected = index
    if maximum > tolerance and selected > 0:
        left = simplify(points[: selected + 1], tolerance)
        right = simplify(points[selected:], tolerance)
        return left[:-1] + right
    return [first, last]


def round_path(points: Sequence[Point]) -> List[List[float]]:
    return [[round(point[0], 2), round(point[1], 2)] for point in points]


def round_geo_path(points: Sequence[Sequence[float]]) -> List[List[float]]:
    output: List[List[float]] = []
    for point in points:
        if len(point) < 2:
            continue
        rounded = [round(float(point[0]), 7), round(float(point[1]), 7)]
        if not output or rounded != output[-1]:
            output.append(rounded)
    return output


def align_stops(route: Dict[str, Any], path: List[Point], via_stops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    official = [str(item) for item in route.get("stations", [])]
    lengths = cumulative_lengths(path)
    candidate_names = [str(item.get("name", "")) for item in via_stops]
    matches: Dict[int, int] = {}
    cursor = 0
    for official_index, official_name in enumerate(official):
        best_index = -1
        best_score = 0.0
        for candidate_index in range(cursor, len(via_stops)):
            score = similarity(official_name, candidate_names[candidate_index])
            if score > best_score:
                best_score = score
                best_index = candidate_index
            if score >= 0.98:
                break
        if best_index >= 0 and best_score >= 0.72:
            matches[official_index] = best_index
            cursor = best_index + 1

    known: Dict[int, Tuple[float, Point, str]] = {}
    for official_index, candidate_index in matches.items():
        candidate = via_stops[candidate_index]
        location = candidate.get("location")
        if isinstance(location, (list, tuple)) and len(location) >= 2:
            projected = mercator(float(location[0]), float(location[1]))
            progress, point = project_point_to_path(projected, path, lengths)
        else:
            progress = candidate_index / float(max(1, len(via_stops) - 1))
            point = point_at_progress(path, lengths, progress)
        known[official_index] = (progress, point, str(candidate.get("name", "")))

    output: List[Dict[str, Any]] = []
    for index, name in enumerate(official):
        if index in known:
            progress, point, amap_name = known[index]
            estimated = False
        else:
            previous = [item for item in known.keys() if item < index]
            following = [item for item in known.keys() if item > index]
            if previous and following:
                left = max(previous)
                right = min(following)
                span = max(1, right - left)
                ratio = (index - left) / float(span)
                progress = known[left][0] + (known[right][0] - known[left][0]) * ratio
            elif previous:
                left = max(previous)
                remaining = max(1, len(official) - 1 - left)
                progress = known[left][0] + (1.0 - known[left][0]) * ((index - left) / float(remaining))
            elif following:
                right = min(following)
                progress = known[right][0] * (index / float(max(1, right)))
            else:
                progress = index / float(max(1, len(official) - 1))
            point = point_at_progress(path, lengths, progress)
            amap_name = ""
            estimated = True
        output.append({
            "name": name,
            "amap_name": amap_name,
            "order": index,
            "progress": max(0.0, min(1.0, float(progress))),
            "projected_x": point[0],
            "projected_y": point[1],
            "estimated": estimated,
        })
    output.sort(key=lambda item: item["order"])
    # Protect against occasional non-monotonic nearest-point results.
    last = 0.0
    for index, item in enumerate(output):
        value = max(last, float(item["progress"]))
        if index == len(output) - 1:
            value = max(value, 1.0 if not item["estimated"] else value)
        item["progress"] = min(1.0, value)
        point = point_at_progress(path, lengths, item["progress"])
        item["projected_x"], item["projected_y"] = point
        last = item["progress"]
    return output


def build(
    db_path: Path = DB_PATH,
    output_path: Path = NETWORK_PATH,
    schematic: bool = True,
    schematic_alpha: float = 0.55,
    schematic_bend: float = 90.0,
) -> Dict[str, Any]:
    selected = selected_routes(db_path=db_path)
    if not selected:
        raise RuntimeError("没有已选中的地铁高德候选。请先打开 /metro/collector 完成采集和复核。")

    usable: List[Dict[str, Any]] = []
    for route in selected:
        candidate = route.get("candidate", {})
        raw_path = [list(point[:2]) for point in candidate.get("path", []) if len(point) >= 2]
        if len(raw_path) < 2:
            continue
        projected_path = [mercator(float(point[0]), float(point[1])) for point in raw_path]
        via_stops = list(candidate.get("via_stops", []))
        if route.get("selected_reversed"):
            raw_path.reverse()
            projected_path.reverse()
            via_stops.reverse()
        aligned = align_stops(route, projected_path, via_stops)
        usable.append({"route": route, "path": projected_path, "gcj02_path": raw_path, "stops": aligned})

    if not usable:
        raise RuntimeError("候选存在，但没有可用线路折线。")

    min_x = min(point[0] for item in usable for point in item["path"])
    max_x = max(point[0] for item in usable for point in item["path"])
    min_y = min(point[1] for item in usable for point in item["path"])
    max_y = max(point[1] for item in usable for point in item["path"])
    width = max(max_x - min_x, 1e-12)
    height = max(max_y - min_y, 1e-12)
    world_height = WORLD_WIDTH * height / width

    def normalize(point: Point) -> Point:
        return ((point[0] - min_x) / width * WORLD_WIDTH, (max_y - point[1]) / width * WORLD_WIDTH)

    route_records: List[Dict[str, Any]] = []
    station_occurrences: List[Dict[str, Any]] = []
    for item in usable:
        route = item["route"]
        normalized_path = [normalize(point) for point in item["path"]]
        gcj02_path = round_geo_path(item["gcj02_path"])
        detail = simplify(normalized_path, 1.0)
        medium = simplify(normalized_path, 7.0)
        overview = simplify(normalized_path, 28.0)
        xs = [point[0] for point in normalized_path]
        ys = [point[1] for point in normalized_path]
        forward_stops = []
        for stop in item["stops"]:
            x, y = normalize((stop["projected_x"], stop["projected_y"]))
            lng, lat = inverse_mercator(stop["projected_x"], stop["projected_y"])
            record = {
                "name": stop["name"],
                "amap_name": stop["amap_name"],
                "order": stop["order"],
                "progress": round(float(stop["progress"]), 6),
                "x": round(x, 2),
                "y": round(y, 2),
                "gcj02": [round(lng, 7), round(lat, 7)],
                "estimated": bool(stop["estimated"]),
            }
            forward_stops.append(record)

        common = {
            "official_id": route["id"],
            "route_no": route["name"],
            "short_name": route.get("short_name", route["name"]),
            "color": route.get("color", "#7da6c8"),
            "operator": "深圳地铁",
            "score": round(float(route.get("match_score") or 0.0), 4),
            "match_state": route.get("query_status", "matched"),
            "auto_selected": False,
            "bbox": [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)],
        }

        forward_id = "{}:forward".format(route["id"])
        forward = {
            **common,
            "id": forward_id,
            "direction": "forward",
            "direction_label": "往{}".format(route["destination"]),
            "start_stop": route["origin"],
            "end_stop": route["destination"],
            "paths": {"overview": round_path(overview), "medium": round_path(medium), "detail": round_path(detail)},
            "geometry": {
                "gcj02": {
                    "path": gcj02_path,
                    "bbox": [
                        min(point[0] for point in gcj02_path),
                        min(point[1] for point in gcj02_path),
                        max(point[0] for point in gcj02_path),
                        max(point[1] for point in gcj02_path),
                    ],
                }
            },
            "stops": forward_stops,
        }
        route_records.append(forward)
        for station in forward_stops:
            station_occurrences.append({**station, "route_id": forward_id, "route_no": route["name"]})

        reverse_path_detail = list(reversed(detail))
        reverse_path_medium = list(reversed(medium))
        reverse_path_overview = list(reversed(overview))
        reverse_gcj02_path = list(reversed(gcj02_path))
        reverse_stops = []
        for new_order, stop in enumerate(reversed(forward_stops)):
            reverse_stops.append({
                **stop,
                "order": new_order,
                "progress": round(1.0 - float(stop["progress"]), 6),
            })
        reverse_id = "{}:reverse".format(route["id"])
        reverse = {
            **common,
            "id": reverse_id,
            "direction": "reverse",
            "direction_label": "往{}".format(route["origin"]),
            "start_stop": route["destination"],
            "end_stop": route["origin"],
            "paths": {"overview": round_path(reverse_path_overview), "medium": round_path(reverse_path_medium), "detail": round_path(reverse_path_detail)},
            "geometry": {
                "gcj02": {
                    "path": reverse_gcj02_path,
                    "bbox": [
                        min(point[0] for point in reverse_gcj02_path),
                        min(point[1] for point in reverse_gcj02_path),
                        max(point[0] for point in reverse_gcj02_path),
                        max(point[1] for point in reverse_gcj02_path),
                    ],
                }
            },
            "stops": reverse_stops,
        }
        route_records.append(reverse)
        for station in reverse_stops:
            station_occurrences.append({**station, "route_id": reverse_id, "route_no": route["name"]})

    threshold = 10.0
    buckets: Dict[Tuple[str, int, int], List[int]] = defaultdict(list)
    clusters: List[Dict[str, Any]] = []
    for occurrence in station_occurrences:
        key_name = normalize_name(occurrence["name"]) or occurrence["name"]
        gx = int(occurrence["x"] // threshold)
        gy = int(occurrence["y"] // threshold)
        chosen: Optional[int] = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for cluster_index in buckets.get((key_name, gx + dx, gy + dy), []):
                    cluster = clusters[cluster_index]
                    if (cluster["x"] - occurrence["x"]) ** 2 + (cluster["y"] - occurrence["y"]) ** 2 <= threshold ** 2:
                        chosen = cluster_index
                        break
                if chosen is not None:
                    break
            if chosen is not None:
                break
        if chosen is None:
            chosen = len(clusters)
            clusters.append({
                "id": "m{}".format(chosen + 1), "name": occurrence["name"], "key": key_name,
                "x": occurrence["x"], "y": occurrence["y"], "samples": 1,
                "estimated_count": 1 if occurrence["estimated"] else 0,
                "route_ids": {occurrence["route_id"]}, "route_nos": {occurrence["route_no"]},
            })
            buckets[(key_name, gx, gy)].append(chosen)
        else:
            cluster = clusters[chosen]
            count = cluster["samples"]
            cluster["x"] = (cluster["x"] * count + occurrence["x"]) / (count + 1)
            cluster["y"] = (cluster["y"] * count + occurrence["y"]) / (count + 1)
            cluster["samples"] = count + 1
            cluster["estimated_count"] += 1 if occurrence["estimated"] else 0
            cluster["route_ids"].add(occurrence["route_id"])
            cluster["route_nos"].add(occurrence["route_no"])

    station_clusters = [{
        "id": item["id"], "name": item["name"], "x": round(item["x"], 2), "y": round(item["y"], 2),
        "route_ids": sorted(item["route_ids"]), "route_nos": sorted(item["route_nos"]),
        "route_count": len(item["route_ids"]), "samples": item["samples"],
        "estimated": item["estimated_count"] == item["samples"],
    } for item in clusters]

    built_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    network = {
        "version": 1,
        "network_id": "sz-metro",
        "type": "metro",
        "name": "深圳地铁",
        "built_at": built_at,
        "world": {
            "width": round(WORLD_WIDTH, 2), "height": round(world_height, 2),
            "gcj02_bounds": [
                round(min(point[0] for item in usable for point in item["route"]["candidate"]["path"]), 7),
                round(min(point[1] for item in usable for point in item["route"]["candidate"]["path"]), 7),
                round(max(point[0] for item in usable for point in item["route"]["candidate"]["path"]), 7),
                round(max(point[1] for item in usable for point in item["route"]["candidate"]["path"]), 7),
            ],
        },
        "stats": {
            "lines": len(usable), "directions": len(route_records),
            "station_occurrences": len(station_occurrences), "station_clusters": len(station_clusters),
            "estimated_station_occurrences": sum(1 for item in station_occurrences if item["estimated"]),
        },
        "routes": route_records,
        "stations": station_clusters,
    }
    if schematic:
        build_schematic_network(network, alpha=schematic_alpha, bend_tolerance=schematic_bend)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(str(output_path), "wt", encoding="utf-8", compresslevel=7) as handle:
        json.dump(network, handle, ensure_ascii=False, separators=(",", ":"))
    return {
        "output": str(output_path), "built_at": built_at, "lines": len(usable),
        "directions": len(route_records), "station_clusters": len(station_clusters),
        "size_bytes": output_path.stat().st_size,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="把地铁高德候选构建为固定坐标线网")
    parser.add_argument("--db", type=Path, default=DB_PATH)
    parser.add_argument("--output", type=Path, default=NETWORK_PATH)
    parser.add_argument("--no-schematic", dest="schematic", action="store_false", help="不生成示意几何")
    parser.add_argument("--schematic-alpha", type=float, default=0.55, help="真实/均匀站距混合系数 α")
    parser.add_argument("--schematic-bend", type=float, default=90.0, help="形状折点 RDP 容差（世界单位）")
    parser.set_defaults(schematic=True)
    args = parser.parse_args()
    print(json.dumps(
        build(args.db, args.output, args.schematic, args.schematic_alpha, args.schematic_bend),
        ensure_ascii=False, indent=2,
    ))


if __name__ == "__main__":
    main()
