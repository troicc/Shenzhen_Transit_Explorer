from __future__ import annotations

import argparse
import gzip
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

from .config import DATA_DIR, DB_PATH, NETWORK_PATH
from .db import iter_direction_matches, normalize_stop, text_similarity

WORLD_WIDTH = 10000.0
EARTH_RADIUS = 6378137.0
FOCUS_DIRECTIONS = tuple(index * math.pi / 4 for index in range(8))


def mercator(lng: float, lat: float) -> Tuple[float, float]:
    lat = max(-85.05112878, min(85.05112878, lat))
    x = EARTH_RADIUS * math.radians(lng)
    y = EARTH_RADIUS * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def inverse_mercator(x: float, y: float) -> Tuple[float, float]:
    lng = math.degrees(x / EARTH_RADIUS)
    lat = math.degrees(2 * math.atan(math.exp(y / EARTH_RADIUS)) - math.pi / 2)
    return lng, lat


def sq_distance(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    return dx * dx + dy * dy


def point_segment_projection(
    p: Tuple[float, float], a: Tuple[float, float], b: Tuple[float, float]
) -> Tuple[float, Tuple[float, float], float]:
    vx, vy = b[0] - a[0], b[1] - a[1]
    denom = vx * vx + vy * vy
    if denom <= 1e-18:
        return 0.0, a, sq_distance(p, a)
    t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / denom
    t = max(0.0, min(1.0, t))
    q = (a[0] + t * vx, a[1] + t * vy)
    return t, q, sq_distance(p, q)


def path_lengths(path: List[Tuple[float, float]]) -> Tuple[List[float], float]:
    cumulative = [0.0]
    total = 0.0
    for a, b in zip(path, path[1:]):
        total += math.hypot(b[0] - a[0], b[1] - a[1])
        cumulative.append(total)
    return cumulative, total


def project_to_path(
    path: List[Tuple[float, float]], point: Tuple[float, float]
) -> Tuple[float, Tuple[float, float]]:
    if len(path) < 2:
        return 0.0, path[0] if path else point
    cumulative, total = path_lengths(path)
    best_dist = float("inf")
    best_progress = 0.0
    best_point = path[0]
    for index, (a, b) in enumerate(zip(path, path[1:])):
        t, q, dist = point_segment_projection(point, a, b)
        if dist < best_dist:
            segment = cumulative[index + 1] - cumulative[index]
            along = cumulative[index] + t * segment
            best_dist = dist
            best_progress = along / total if total else 0.0
            best_point = q
    return best_progress, best_point


def point_at_progress(path: List[Tuple[float, float]], progress: float) -> Tuple[float, float]:
    if not path:
        return 0.0, 0.0
    if len(path) == 1:
        return path[0]
    cumulative, total = path_lengths(path)
    if total <= 0:
        return path[0]
    target = max(0.0, min(1.0, progress)) * total
    for index in range(len(path) - 1):
        if cumulative[index + 1] >= target:
            span = cumulative[index + 1] - cumulative[index]
            t = 0.0 if span == 0 else (target - cumulative[index]) / span
            a, b = path[index], path[index + 1]
            return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
    return path[-1]


def perpendicular_distance(
    point: Tuple[float, float], start: Tuple[float, float], end: Tuple[float, float]
) -> float:
    return math.sqrt(point_segment_projection(point, start, end)[2])


def simplify(path: List[Tuple[float, float]], tolerance: float) -> List[Tuple[float, float]]:
    if len(path) <= 2 or tolerance <= 0:
        return path[:]

    keep = [False] * len(path)
    keep[0] = keep[-1] = True
    stack = [(0, len(path) - 1)]
    while stack:
        start, end = stack.pop()
        max_distance = 0.0
        max_index = -1
        for index in range(start + 1, end):
            distance = perpendicular_distance(path[index], path[start], path[end])
            if distance > max_distance:
                max_distance = distance
                max_index = index
        if max_index >= 0 and max_distance > tolerance:
            keep[max_index] = True
            stack.append((start, max_index))
            stack.append((max_index, end))
    return [point for index, point in enumerate(path) if keep[index]]


def align_official_stops(
    official_names: List[str],
    candidate_stops: List[Dict[str, Any]],
    projected_path: List[Tuple[float, float]],
) -> List[Dict[str, Any]]:
    candidate_progress: List[float] = []
    for stop in candidate_stops:
        location = stop.get("location") or []
        if len(location) >= 2:
            progress, _ = project_to_path(
                projected_path, mercator(float(location[0]), float(location[1]))
            )
        else:
            progress = 0.0
        candidate_progress.append(progress)

    matches: Dict[int, int] = {}
    cursor = 0
    for official_index, official_name in enumerate(official_names):
        best_index = -1
        best_score = 0.0
        # Monotonic matching keeps route order. Search the remaining stops only.
        for candidate_index in range(cursor, len(candidate_stops)):
            score = text_similarity(
                official_name, candidate_stops[candidate_index].get("name", ""), stop=True
            )
            if score > best_score:
                best_score = score
                best_index = candidate_index
            if score >= 0.98:
                break
        if best_index >= 0 and best_score >= 0.72:
            matches[official_index] = best_index
            cursor = best_index + 1

    output: List[Dict[str, Any]] = []
    matched_official = sorted(matches)
    for index, name in enumerate(official_names):
        if index in matches:
            candidate_index = matches[index]
            progress = candidate_progress[candidate_index]
            estimated = False
            amap_name = candidate_stops[candidate_index].get("name", "")
        else:
            before = [value for value in matched_official if value < index]
            after = [value for value in matched_official if value > index]
            if before and after:
                left, right = before[-1], after[0]
                left_progress = candidate_progress[matches[left]]
                right_progress = candidate_progress[matches[right]]
                ratio = (index - left) / max(1, right - left)
                progress = left_progress + (right_progress - left_progress) * ratio
            elif before:
                left = before[-1]
                left_progress = candidate_progress[matches[left]]
                remaining = len(official_names) - 1 - left
                progress = left_progress + (1.0 - left_progress) * (index - left) / max(1, remaining)
            elif after:
                right = after[0]
                right_progress = candidate_progress[matches[right]]
                progress = right_progress * index / max(1, right)
            else:
                progress = index / max(1, len(official_names) - 1)
            estimated = True
            amap_name = ""
        x, y = point_at_progress(projected_path, progress)
        output.append(
            {
                "name": name,
                "amap_name": amap_name,
                "progress": round(progress, 7),
                "projected_x": x,
                "projected_y": y,
                "estimated": estimated,
            }
        )
    return output


def round_path(path: List[Tuple[float, float]]) -> List[List[float]]:
    return [[round(x, 2), round(y, 2)] for x, y in path]


def round_geo_path(path: List[List[float]]) -> List[List[float]]:
    return [[round(float(point[0]), 7), round(float(point[1]), 7)] for point in path]


def _angle_delta(start: float, end: float) -> float:
    return math.atan2(math.sin(end - start), math.cos(end - start))


def _focus_lengths(points: List[Tuple[float, float]], balanced: bool) -> List[float]:
    raw = [max(1e-6, math.dist(start, end)) for start, end in zip(points, points[1:])]
    typical = median(raw) if raw else 1.0
    if balanced:
        return [112.0] * len(raw)
    return [max(66.0, min(190.0, 88.0 * math.sqrt(value / typical))) for value in raw]


def _focus_path_from_directions(lengths: List[float], directions: Tuple[int, ...]) -> List[Tuple[float, float]]:
    output = [(0.0, 0.0)]
    for length, direction in zip(lengths, directions):
        angle = FOCUS_DIRECTIONS[direction]
        previous = output[-1]
        output.append(
            (
                previous[0] + math.cos(angle) * length,
                previous[1] + math.sin(angle) * length,
            )
        )
    return output


def _segments_intersect(
    a: Tuple[float, float],
    b: Tuple[float, float],
    c: Tuple[float, float],
    d: Tuple[float, float],
) -> bool:
    epsilon = 1e-7

    def cross(p: Tuple[float, float], q: Tuple[float, float], r: Tuple[float, float]) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    def on_segment(p: Tuple[float, float], q: Tuple[float, float], r: Tuple[float, float]) -> bool:
        return (
            min(p[0], r[0]) - epsilon <= q[0] <= max(p[0], r[0]) + epsilon
            and min(p[1], r[1]) - epsilon <= q[1] <= max(p[1], r[1]) + epsilon
        )

    ab_c, ab_d = cross(a, b, c), cross(a, b, d)
    cd_a, cd_b = cross(c, d, a), cross(c, d, b)
    if ((ab_c > epsilon and ab_d < -epsilon) or (ab_c < -epsilon and ab_d > epsilon)) and (
        (cd_a > epsilon and cd_b < -epsilon) or (cd_a < -epsilon and cd_b > epsilon)
    ):
        return True
    if abs(ab_c) <= epsilon and on_segment(a, c, b):
        return True
    if abs(ab_d) <= epsilon and on_segment(a, d, b):
        return True
    if abs(cd_a) <= epsilon and on_segment(c, a, d):
        return True
    if abs(cd_b) <= epsilon and on_segment(c, b, d):
        return True
    return False


def focus_self_intersections(path: List[Tuple[float, float]]) -> int:
    count = 0
    for first in range(len(path) - 1):
        for second in range(first + 2, len(path) - 1):
            if first == 0 and second == len(path) - 2 and path[0] == path[-1]:
                continue
            if _segments_intersect(path[first], path[first + 1], path[second], path[second + 1]):
                count += 1
    return count


def _monotonic_focus_path(
    source: List[Tuple[float, float]], lengths: List[float]
) -> List[Tuple[float, float]]:
    xs = [point[0] for point in source]
    ys = [point[1] for point in source]
    dx = source[-1][0] - source[0][0]
    dy = source[-1][1] - source[0][1]
    horizontal = abs(dx) >= abs(dy)
    if abs(dx) + abs(dy) < 1e-6:
        horizontal = max(xs) - min(xs) >= max(ys) - min(ys)
    main_sign = 1 if (dx if horizontal else dy) >= 0 else -1
    output = [(0.0, 0.0)]
    diagonal = math.sqrt(0.5)
    for index, length in enumerate(lengths):
        raw_dx = source[index + 1][0] - source[index][0]
        raw_dy = source[index + 1][1] - source[index][1]
        previous = output[-1]
        if horizontal:
            use_diagonal = abs(raw_dy) > abs(raw_dx) * 0.35
            step_x = main_sign * length * (diagonal if use_diagonal else 1.0)
            step_y = (1 if raw_dy >= 0 else -1) * length * diagonal if use_diagonal else 0.0
        else:
            use_diagonal = abs(raw_dx) > abs(raw_dy) * 0.35
            step_x = (1 if raw_dx >= 0 else -1) * length * diagonal if use_diagonal else 0.0
            step_y = main_sign * length * (diagonal if use_diagonal else 1.0)
        output.append((previous[0] + step_x, previous[1] + step_y))
    return output


def build_focus_geometry(
    source_points: List[Tuple[float, float]], balanced: bool = True
) -> Dict[str, Any]:
    """Build a deterministic, station-ordered, octilinear practice geometry."""
    if len(source_points) < 2:
        path = source_points[:] or [(0.0, 0.0)]
        return {
            "path": round_path(path),
            "stationPoints": round_path(path),
            "stationProgresses": [0.0] * len(path),
            "bbox": [0.0, 0.0, 0.0, 0.0],
            "fallback": False,
        }

    lengths = _focus_lengths(source_points, balanced)
    raw_angles: List[float] = []
    last_angle = 0.0
    for start, end in zip(source_points, source_points[1:]):
        if math.dist(start, end) > 1e-6:
            last_angle = math.atan2(end[1] - start[1], end[0] - start[0])
        raw_angles.append(last_angle)

    # Viterbi state remembers two directions so alternating A-B-A zigzags can be penalized.
    states: Dict[Tuple[int, int], Tuple[float, Tuple[int, ...]]] = {}
    for direction in range(8):
        local = 5.0 * _angle_delta(raw_angles[0], FOCUS_DIRECTIONS[direction]) ** 2
        states[(direction, direction)] = (local, (direction,))

    for interval in range(1, len(raw_angles)):
        next_states: Dict[Tuple[int, int], Tuple[float, Tuple[int, ...]]] = {}
        for (previous_previous, previous), (cost, chosen) in states.items():
            first_turn = _angle_delta(
                FOCUS_DIRECTIONS[previous_previous], FOCUS_DIRECTIONS[previous]
            )
            for direction in range(8):
                second_turn = _angle_delta(
                    FOCUS_DIRECTIONS[previous], FOCUS_DIRECTIONS[direction]
                )
                local = 5.0 * _angle_delta(
                    raw_angles[interval], FOCUS_DIRECTIONS[direction]
                ) ** 2
                turn = 0.42 * abs(second_turn) + 0.28 * second_turn**2
                reverse_penalty = 8.0 if abs(second_turn) > math.pi * 0.74 else 0.0
                zigzag = 0.0
                if first_turn * second_turn < -1e-7:
                    zigzag += 1.35 * min(abs(first_turn), abs(second_turn))
                if direction == previous_previous and direction != previous:
                    zigzag += 1.5
                candidate = (
                    cost + local + turn + reverse_penalty + zigzag,
                    chosen + (direction,),
                )
                key = (previous, direction)
                existing = next_states.get(key)
                if existing is None or candidate < existing:
                    next_states[key] = candidate
        states = next_states

    source_lengths = [math.dist(start, end) for start, end in zip(source_points, source_points[1:])]
    source_typical = max(1e-6, median(source_lengths))
    scale = median(lengths) / source_typical
    target = (
        (source_points[-1][0] - source_points[0][0]) * scale,
        (source_points[-1][1] - source_points[0][1]) * scale,
    )
    route_length = max(1.0, sum(lengths))
    finalists = []
    for cost, directions in states.values():
        candidate_path = _focus_path_from_directions(lengths, directions)
        endpoint = candidate_path[-1]
        drift = math.dist(endpoint, target) / route_length
        endpoint_cost = 26.0 * drift**2
        finalists.append((cost + endpoint_cost, directions, candidate_path))
    _, _, path = min(finalists, key=lambda item: (item[0], item[1]))

    used_fallback = focus_self_intersections(path) > 0
    if used_fallback:
        path = _monotonic_focus_path(source_points, lengths)

    cumulative, total = path_lengths(path)
    progresses = [round(value / total, 7) if total else 0.0 for value in cumulative]
    min_x = min(point[0] for point in path)
    min_y = min(point[1] for point in path)
    max_x = max(point[0] for point in path)
    max_y = max(point[1] for point in path)
    rounded = round_path(path)
    return {
        "path": rounded,
        "stationPoints": rounded,
        "stationProgresses": progresses,
        "bbox": [round(min_x, 2), round(min_y, 2), round(max_x, 2), round(max_y, 2)],
        "fallback": used_fallback,
    }


def _write_gzip_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=7) as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))


def publish_split_data(network: Dict[str, Any], data_dir: Path = DATA_DIR) -> Dict[str, Any]:
    route_dir = data_dir / "routes"
    overview_routes = [
        {
            "id": route["id"],
            "official_id": route["official_id"],
            "route_no": route["route_no"],
            "direction": route["direction"],
            "direction_label": route["direction_label"],
            "operator": route["operator"],
            "start_stop": route["start_stop"],
            "end_stop": route["end_stop"],
            "score": route["score"],
            "match_state": route["match_state"],
            "bbox": route["bbox"],
            "path": route["paths"]["overview"],
            "stop_count": len(route.get("stops", [])),
        }
        for route in network.get("routes", [])
    ]
    overview = {
        "version": network["version"],
        "built_at": network["built_at"],
        "world": network["world"],
        "stats": network["stats"],
        "routes": overview_routes,
    }
    overview_path = data_dir / "overview.json.gz"
    _write_gzip_json(overview_path, overview)

    manifest_routes = []
    for route in network.get("routes", []):
        filename = quote(str(route["id"]), safe="") + ".json.gz"
        relative_path = f"routes/{filename}"
        _write_gzip_json(
            route_dir / filename,
            {
                "version": network["version"],
                "built_at": network["built_at"],
                "world": network["world"],
                "route": route,
            },
        )
        manifest_routes.append(
            {
                "id": route["id"],
                "route_no": route["route_no"],
                "direction": route["direction"],
                "direction_label": route["direction_label"],
                "start_stop": route["start_stop"],
                "end_stop": route["end_stop"],
                "bbox": route["bbox"],
                "stop_count": len(route.get("stops", [])),
                "data_path": relative_path,
            }
        )

    manifest = {
        "version": network["version"],
        "built_at": network["built_at"],
        "overview_path": "overview.json.gz",
        "routes": manifest_routes,
        "search": {
            "stations": [
                {
                    "id": station["id"],
                    "name": station["name"],
                    "route_ids": station["route_ids"],
                }
                for station in network.get("stations", [])
            ]
        },
    }
    manifest_path = data_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return {
        "manifest": str(manifest_path),
        "overview": str(overview_path),
        "route_files": len(manifest_routes),
    }


def build(db_path: Path = DB_PATH, output_path: Optional[Path] = None, include_review: bool = True) -> Dict[str, Any]:
    output_path = output_path or NETWORK_PATH
    raw_matches = list(iter_direction_matches(db_path, include_review=include_review))
    usable: List[Dict[str, Any]] = []
    all_projected_points: List[Tuple[float, float]] = []

    for match in raw_matches:
        candidate = match["candidate"]
        path = candidate.get("path") or []
        if len(path) < 2:
            continue
        projected_path = [mercator(float(point[0]), float(point[1])) for point in path]
        official_stops = align_official_stops(
            match["official"].get("stops") or [],
            candidate.get("via_stops") or [],
            projected_path,
        )
        usable.append({**match, "projected_path": projected_path, "aligned_stops": official_stops})
        all_projected_points.extend(projected_path)

    if not all_projected_points:
        raise RuntimeError("没有可构建的高德线路数据。请先打开 /collector 完成采集。")

    min_x = min(point[0] for point in all_projected_points)
    max_x = max(point[0] for point in all_projected_points)
    min_y = min(point[1] for point in all_projected_points)
    max_y = max(point[1] for point in all_projected_points)
    source_width = max(max_x - min_x, 1.0)
    source_height = max(max_y - min_y, 1.0)
    scale = WORLD_WIDTH / source_width
    world_height = source_height * scale

    def normalize(point: Tuple[float, float]) -> Tuple[float, float]:
        return (point[0] - min_x) * scale, (max_y - point[1]) * scale

    routes: List[Dict[str, Any]] = []
    station_occurrences: List[Dict[str, Any]] = []
    for match in usable:
        route_key = f"{match['route_id']}:{match['direction']}"
        normalized_path = [normalize(point) for point in match["projected_path"]]
        gcj02_path = round_geo_path(match["candidate"].get("path") or [])
        full = simplify(normalized_path, 1.2)
        medium = simplify(normalized_path, 7.0)
        overview = simplify(normalized_path, 28.0)
        xs = [point[0] for point in normalized_path]
        ys = [point[1] for point in normalized_path]
        stops = []
        for order, stop in enumerate(match["aligned_stops"]):
            x, y = normalize((stop["projected_x"], stop["projected_y"]))
            lng, lat = inverse_mercator(stop["projected_x"], stop["projected_y"])
            item = {
                "name": stop["name"],
                "amap_name": stop["amap_name"],
                "order": order,
                "progress": stop["progress"],
                "overviewProgress": stop["progress"],
                "x": round(x, 2),
                "y": round(y, 2),
                "gcj02": [round(lng, 7), round(lat, 7)],
                "estimated": bool(stop["estimated"]),
            }
            stops.append(item)
            station_occurrences.append({**item, "route_id": route_key, "route_no": match["route_no"]})

        focus = build_focus_geometry(
            [(float(stop["x"]), float(stop["y"])) for stop in stops], balanced=True
        )
        for stop, focus_point, focus_progress in zip(
            stops, focus["stationPoints"], focus["stationProgresses"]
        ):
            stop["focus"] = focus_point
            stop["focusProgress"] = focus_progress

        gcj_lngs = [point[0] for point in gcj02_path]
        gcj_lats = [point[1] for point in gcj02_path]

        routes.append(
            {
                "id": route_key,
                "official_id": match["route_id"],
                "route_no": match["route_no"],
                "direction": match["direction"],
                "direction_label": match["official"].get("label", match["direction"]),
                "operator": match["operator"],
                "start_stop": match["official"].get("start_stop", ""),
                "end_stop": match["official"].get("end_stop", ""),
                "score": round(float(match["score"]), 4),
                "match_state": match["match_state"],
                "auto_selected": match["auto_selected"],
                "bbox": [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)],
                "paths": {
                    "overview": round_path(overview),
                    "medium": round_path(medium),
                    "detail": round_path(full),
                },
                "geometry": {
                    "overview": round_path(overview),
                    "focus": focus,
                    "gcj02": {
                        "path": gcj02_path,
                        "bbox": [
                            round(min(gcj_lngs), 7),
                            round(min(gcj_lats), 7),
                            round(max(gcj_lngs), 7),
                            round(max(gcj_lats), 7),
                        ],
                    },
                },
                "stops": stops,
            }
        )

    # Cluster station occurrences with the same normalized name within about 120 m.
    # Shenzhen's width maps to 10,000 units; 12 units is roughly 100-150 m.
    threshold = 12.0
    buckets: Dict[Tuple[str, int, int], List[int]] = defaultdict(list)
    clusters: List[Dict[str, Any]] = []
    for occurrence in station_occurrences:
        key_name = normalize_stop(occurrence["name"]) or occurrence["name"]
        gx = int(occurrence["x"] // threshold)
        gy = int(occurrence["y"] // threshold)
        chosen = None
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
            clusters.append(
                {
                    "id": f"s{chosen + 1}",
                    "name": occurrence["name"],
                    "key": key_name,
                    "x": occurrence["x"],
                    "y": occurrence["y"],
                    "samples": 1,
                    "estimated_count": 1 if occurrence["estimated"] else 0,
                    "route_ids": {occurrence["route_id"]},
                    "route_nos": {occurrence["route_no"]},
                }
            )
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

    station_clusters = []
    for cluster in clusters:
        station_clusters.append(
            {
                "id": cluster["id"],
                "name": cluster["name"],
                "x": round(cluster["x"], 2),
                "y": round(cluster["y"], 2),
                "route_ids": sorted(cluster["route_ids"]),
                "route_nos": sorted(cluster["route_nos"]),
                "route_count": len(cluster["route_ids"]),
                "samples": cluster["samples"],
                "estimated": cluster["estimated_count"] == cluster["samples"],
            }
        )

    built_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    network = {
        "version": 2,
        "built_at": built_at,
        "world": {
            "width": round(WORLD_WIDTH, 2),
            "height": round(world_height, 2),
            "gcj02_bounds": [
                round(min(point[0] for item in usable for point in item["candidate"]["path"]), 7),
                round(min(point[1] for item in usable for point in item["candidate"]["path"]), 7),
                round(max(point[0] for item in usable for point in item["candidate"]["path"]), 7),
                round(max(point[1] for item in usable for point in item["candidate"]["path"]), 7),
            ],
        },
        "stats": {
            "directions": len(routes),
            "station_occurrences": len(station_occurrences),
            "station_clusters": len(station_clusters),
            "estimated_station_occurrences": sum(1 for item in station_occurrences if item["estimated"]),
            "focus_fallbacks": sum(
                1
                for route in routes
                if route.get("geometry", {}).get("focus", {}).get("fallback")
            ),
        },
        "routes": routes,
        "stations": station_clusters,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output_path, "wt", encoding="utf-8", compresslevel=7) as handle:
        json.dump(network, handle, ensure_ascii=False, separators=(",", ":"))
    published = publish_split_data(network, output_path.parent)
    return {
        "output": str(output_path),
        "built_at": built_at,
        "directions": len(routes),
        "station_occurrences": len(station_occurrences),
        "station_clusters": len(station_clusters),
        "size_bytes": output_path.stat().st_size,
        **published,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="把已缓存的高德线路编译为高效全网数据")
    parser.add_argument("--db", type=Path, default=DB_PATH)
    parser.add_argument("--output", type=Path, default=NETWORK_PATH)
    parser.add_argument("--matched-only", action="store_true", help="不纳入待复核线路")
    args = parser.parse_args()
    result = build(args.db, args.output, include_review=not args.matched_only)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
