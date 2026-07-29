"""地铁示意几何生成器。

把真实几何（paths.detail + stops[].progress）转换为横竖/45° 八方向示意骨架，
并支持全网换乘锚点求解，使同一换乘站在所有经过线路的示意里共用同一坐标
（构造性共点，不再依赖事后 snap）。

本文件中的纯数学函数刻意与 ``web/js/learn/geometry.js`` + ``web/js/learn/core.js``
一一对应（同名同算法同常量），以便 Python 端口与 JS 原版逐点互验。
当 ``alpha is None`` 时 ``build_schematic_route`` 与 JS ``buildSchematic`` 数值等价。
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

Point = Tuple[float, float]


# ---------------------------------------------------------------------------
# 基础原语 — 对应 web/js/learn/core.js
# ---------------------------------------------------------------------------

def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def distance(a: Point, b: Point) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def bbox_of(points: Sequence[Point]) -> List[float]:
    if not points:
        return [0.0, 0.0, 100.0, 100.0]
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def path_metrics(points: Sequence[Point]) -> Tuple[List[float], float]:
    """对应 core.js pathMetrics：返回 (cumulative, total)。"""
    cumulative = [0.0]
    total = 0.0
    for index in range(1, len(points)):
        total += distance(points[index - 1], points[index])
        cumulative.append(total)
    return cumulative, total


def point_at_progress(points: Sequence[Point], progress: float) -> Point:
    """对应 core.js pointAtProgress。"""
    if not points:
        return (0.0, 0.0)
    if len(points) == 1:
        return (float(points[0][0]), float(points[0][1]))
    cumulative, total = path_metrics(points)
    if not total:
        return (float(points[0][0]), float(points[0][1]))
    target = clamp(progress, 0.0, 1.0) * total
    for index in range(1, len(points)):
        if cumulative[index] >= target:
            span = (cumulative[index] - cumulative[index - 1]) or 1.0
            ratio = (target - cumulative[index - 1]) / span
            return (
                lerp(points[index - 1][0], points[index][0], ratio),
                lerp(points[index - 1][1], points[index][1], ratio),
            )
    return (float(points[-1][0]), float(points[-1][1]))


# ---------------------------------------------------------------------------
# 区间/折线工具 — 对应 web/js/learn/geometry.js 顶部
# ---------------------------------------------------------------------------

def rdp(points: Sequence[Point], tolerance: float) -> List[Point]:
    """对应 geometry.js rdp（RDP 简化）。"""
    if len(points) <= 2:
        return [[float(p[0]), float(p[1])] for p in points]
    farthest = 0.0
    farthest_index = -1
    for index in range(1, len(points) - 1):
        value = _point_segment_distance(points[index], points[0], points[-1])
        if value > farthest:
            farthest = value
            farthest_index = index
    if farthest_index < 0 or farthest <= tolerance:
        return [[float(points[0][0]), float(points[0][1])], [float(points[-1][0]), float(points[-1][1])]]
    left = rdp(points[: farthest_index + 1], tolerance)
    right = rdp(points[farthest_index:], tolerance)
    return left[:-1] + right


def _point_segment_distance(point: Point, start: Point, end: Point) -> float:
    """对应 core.js pointSegmentDistance（仅返回距离）。"""
    vx = end[0] - start[0]
    vy = end[1] - start[1]
    denominator = vx * vx + vy * vy
    ratio = 0.0
    if denominator:
        ratio = clamp(((point[0] - start[0]) * vx + (point[1] - start[1]) * vy) / denominator, 0.0, 1.0)
    projected = (start[0] + ratio * vx, start[1] + ratio * vy)
    return math.hypot(point[0] - projected[0], point[1] - projected[1])


def cap_points(points: Sequence[Point], count: int) -> List[Point]:
    """对应 geometry.js capPoints。"""
    if len(points) <= count:
        return [[float(p[0]), float(p[1])] for p in points]
    output: List[Point] = []
    for index in range(count):
        source = round(index * (len(points) - 1) / (count - 1))
        output.append([float(points[source][0]), float(points[source][1])])
    return output


def slice_path(points: Sequence[Point], start_progress: float, end_progress: float) -> List[Point]:
    """对应 geometry.js slicePath。"""
    if len(points) < 2:
        return [[float(p[0]), float(p[1])] for p in points]
    cumulative, total = path_metrics(points)
    if not total:
        return [[float(points[0][0]), float(points[0][1])], [float(points[-1][0]), float(points[-1][1])]]
    start = clamp(start_progress, 0.0, 1.0) * total
    end = clamp(end_progress, 0.0, 1.0) * total
    low = min(start, end)
    high = max(start, end)
    output: List[Point] = [list(point_at_progress(points, low / total))]  # type: ignore[arg-type]
    for index in range(1, len(points) - 1):
        if cumulative[index] > low and cumulative[index] < high:
            output.append([float(points[index][0]), float(points[index][1])])
    output.append(list(point_at_progress(points, high / total)))  # type: ignore[arg-type]
    return output if start <= end else output[::-1]


def snap_angle(dx: float, dy: float) -> float:
    """对应 geometry.js snapAngle：吸附到 45° 倍数。"""
    return round(math.atan2(dy, dx) / (math.pi / 4)) * (math.pi / 4)


def remove_near_duplicates(points: Sequence[Point], threshold: float = 0.2) -> List[Point]:
    output: List[Point] = []
    for point in points:
        if not output or distance(output[-1], point) > threshold:
            output.append([float(point[0]), float(point[1])])
    return output


def simplify_interval(points: Sequence[Point]) -> List[Point]:
    """对应 geometry.js simplifyInterval：单区间简化到 ≤4 个折点。"""
    if len(points) <= 2:
        return [[float(p[0]), float(p[1])] for p in points]
    box = bbox_of(points)
    diagonal = math.hypot(box[2] - box[0], box[3] - box[1])
    return cap_points(rdp(points, max(2.0, diagonal * 0.055)), 4)


def segment_length(points: Sequence[Point]) -> float:
    return path_metrics(points)[1]


def median(values: Sequence[float]) -> float:
    if not values:
        return 1.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def merge_collinear(points: Sequence[Point]) -> List[Point]:
    """对应 geometry.js mergeCollinear：合并同向折点。"""
    if len(points) < 3:
        return [[float(p[0]), float(p[1])] for p in points]
    output: List[Point] = [[float(points[0][0]), float(points[0][1])]]
    for index in range(1, len(points) - 1):
        a = output[-1]
        b = points[index]
        c = points[index + 1]
        angle1 = math.atan2(b[1] - a[1], b[0] - a[0])
        angle2 = math.atan2(c[1] - b[1], c[0] - b[0])
        delta = abs(math.atan2(math.sin(angle2 - angle1), math.cos(angle2 - angle1)))
        if delta > 0.01:
            output.append([float(b[0]), float(b[1])])
    output.append([float(points[-1][0]), float(points[-1][1])])
    return remove_near_duplicates(output)


def project_point_to_path(points: Sequence[Point], point: Point) -> Dict[str, Any]:
    """对应 geometry.js projectPointToPath：返回 {progress, point, distance}。"""
    if len(points) < 2:
        anchor = [float(points[0][0]), float(points[0][1])] if points else [float(point[0]), float(point[1])]
        return {"progress": 0.0, "point": anchor, "distance": 0.0}
    cumulative, total = path_metrics(points)
    best_distance = float("inf")
    best_point: Point = (float(points[0][0]), float(points[0][1]))
    best_along = 0.0
    for index in range(1, len(points)):
        start = points[index - 1]
        end = points[index]
        vx = end[0] - start[0]
        vy = end[1] - start[1]
        denominator = vx * vx + vy * vy
        ratio = 0.0
        if denominator:
            ratio = clamp(((point[0] - start[0]) * vx + (point[1] - start[1]) * vy) / denominator, 0.0, 1.0)
        projected = (start[0] + ratio * vx, start[1] + ratio * vy)
        value = math.hypot(point[0] - projected[0], point[1] - projected[1])
        if value < best_distance:
            best_distance = value
            best_point = projected
            span = cumulative[index] - cumulative[index - 1]
            best_along = cumulative[index - 1] + span * ratio
    return {"progress": best_along / total if total else 0.0, "point": best_point, "distance": best_distance}


# ---------------------------------------------------------------------------
# 单线示意生成 — 对应 geometry.js buildSchematic / buildGeographic
# ---------------------------------------------------------------------------

def _stop_progress(stop: Any, index: int, count: int) -> float:
    fallback = index / max(1, count - 1)
    if isinstance(stop, dict):
        raw = stop.get("progress")
        if raw is not None:
            try:
                value = float(raw)
            except (TypeError, ValueError):
                return fallback
            if math.isfinite(value):
                return clamp(value, 0.0, 1.0)
    return fallback


def build_schematic_route(
    path: Sequence[Point],
    stops: Sequence[Any],
    balanced: bool = False,
    alpha: Optional[float] = None,
) -> Dict[str, Any]:
    """单条线路的真实几何 → 八方向示意。

    - ``alpha is None`` 时与 JS ``buildSchematic(path, stops, balanced)`` 数值等价
      （``balanced=True`` 走 112px 均匀；``balanced=False`` 走 sqrt 真实站距）。
    - ``alpha`` 给定时启用文档推荐的 α 混合站距：
      ``weight = α*real_span + (1-α)*even_span``，区间目标长度 = ``BASE*(n-1)*weight``，
      再夹到 [MIN_INTERVAL, MAX_INTERVAL]。α=0 等价均匀；α=1 等价纯真实。

    返回 ``{mode, path, station_points, station_progresses, bbox}``。
    """
    source_path = [[float(p[0]), float(p[1])] for p in (path or [])]
    stops_list = list(stops or [])
    if len(source_path) < 2 or len(stops_list) < 2:
        return _build_geographic(source_path, stops_list)

    count = len(stops_list)
    progresses = [_stop_progress(stops_list[i], i, count) for i in range(count)]
    for i in range(1, count):
        progresses[i] = max(progresses[i], progresses[i - 1] + 1e-7)
    progresses[-1] = max(progresses[-1], 1.0)

    intervals: List[Dict[str, Any]] = []
    for i in range(count - 1):
        source = slice_path(source_path, progresses[i], progresses[i + 1])
        intervals.append({"source": source, "length": max(1.0, segment_length(source))})
    typical = median([iv["length"] for iv in intervals])

    base_interval = 112.0
    min_interval = 46.0
    max_interval = 260.0
    even_span = 1.0 / max(1, count - 1)

    def desired_for(index: int, interval: Dict[str, Any]) -> float:
        if alpha is not None:
            real_span = progresses[index + 1] - progresses[index]
            weight = alpha * real_span + (1.0 - alpha) * even_span
            return clamp(base_interval * max(1, count - 1) * weight, min_interval, max_interval)
        if balanced:
            return 112.0
        return clamp(88.0 * math.sqrt(interval["length"] / max(1.0, typical)), 66.0, 190.0)

    schematic_path: List[Point] = [[0.0, 0.0]]
    station_points: List[Point] = [[0.0, 0.0]]
    for i, interval in enumerate(intervals):
        simplified = simplify_interval(interval["source"])
        vectors: List[Dict[str, float]] = []
        for j in range(1, len(simplified)):
            dx = simplified[j][0] - simplified[j - 1][0]
            dy = simplified[j][1] - simplified[j - 1][1]
            raw_length = math.hypot(dx, dy)
            if raw_length > 0:
                vectors.append({"angle": snap_angle(dx, dy), "raw": raw_length})
        if not vectors:
            vectors.append({"angle": 0.0, "raw": 1.0})
        desired = desired_for(i, interval)
        raw_total = sum(v["raw"] for v in vectors) or 1.0
        current = list(schematic_path[-1])
        for vector in vectors:
            part = max(18.0, desired * vector["raw"] / raw_total)
            current = [current[0] + math.cos(vector["angle"]) * part, current[1] + math.sin(vector["angle"]) * part]
            schematic_path.append([current[0], current[1]])
        station_points.append([current[0], current[1]])

    merged = merge_collinear(schematic_path)
    station_progresses = [project_point_to_path(merged, sp)["progress"] for sp in station_points]
    corrected = [list(point_at_progress(merged, p)) for p in station_progresses]
    return {
        "mode": "schematic",
        "path": merged,
        "station_points": corrected,
        "station_progresses": station_progresses,
        "bbox": bbox_of(merged),
    }


def _build_geographic(path: List[Point], stops: Sequence[Any]) -> Dict[str, Any]:
    count = len(stops or [])
    progresses = [_stop_progress(stops[i], i, count) for i in range(count)]
    points = [list(point_at_progress(path, p)) for p in progresses]
    return {
        "mode": "geographic",
        "path": path,
        "station_progresses": progresses,
        "station_points": points,
        "bbox": bbox_of(path),
    }


# ---------------------------------------------------------------------------
# A3 — 全网换乘锚点
# ---------------------------------------------------------------------------

def _default_normalize(value: str) -> str:
    """惰性导入地铁站名归一化器，避免 builder 与示意模块循环导入。"""
    from ..networks.metro.matcher import normalize_name
    return normalize_name(value)


def compute_anchors(
    routes: Sequence[Dict[str, Any]],
    normalize=_default_normalize,
) -> Dict[str, Dict[str, Any]]:
    """识别全网换乘锚点。

    判定标准：归一化站名被 **≥2 条不同线路**（按 route_no 去重，避免 forward/reverse
    同线算两次）经过即为换乘锚点。位置取该站所有实例真实坐标的质心，从而跨线共享。
    """
    occurrences: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for route in routes:
        route_no = route.get("route_no", "")
        for index, stop in enumerate(route.get("stops", [])):
            raw_name = str(stop.get("name", ""))
            key = normalize(raw_name) or raw_name
            occurrences[key].append({
                "route_id": route["id"],
                "route_no": route_no,
                "stop_idx": index,
                "x": float(stop["x"]),
                "y": float(stop["y"]),
                "name": raw_name,
            })
    hubs: Dict[str, Dict[str, Any]] = {}
    for key, items in occurrences.items():
        distinct_lines = {item["route_no"] for item in items}
        if len(distinct_lines) < 2:
            continue
        cx = sum(item["x"] for item in items) / len(items)
        cy = sum(item["y"] for item in items) / len(items)
        hubs[key] = {
            "name": items[0]["name"],
            "x": cx,
            "y": cy,
            "lines": sorted(distinct_lines),
        }
    return hubs


# ---------------------------------------------------------------------------
# A4 — 全网示意组装（构造性共点）
# ---------------------------------------------------------------------------

def _octilinear_midpoints(a: Point, b: Point) -> List[Point]:
    """a→b 的八方向折线中间点（不含 a，含 b），≤2 段，保证终于 b。

    把位移 D=(dx,dy) 分解为一段轴向（水平/垂直）+ 一段 45° 对角：
    - |dx|≥|dy|：先水平 |dx|-|dy|，再 45° |dy|；
    - |dy|>|dx|：先垂直 |dy|-|dx|，再 45° |dx|。
    任一两定点之间都返回纯八方向折线，故整网天然 octilinear。
    """
    ax, ay = float(a[0]), float(a[1])
    bx, by = float(b[0]), float(b[1])
    dx, dy = bx - ax, by - ay
    adx, ady = abs(dx), abs(dy)
    if adx < 1e-9 and ady < 1e-9:
        return [[bx, by]]
    sx = 1.0 if dx > 0 else (-1.0 if dx < 0 else 0.0)
    sy = 1.0 if dy > 0 else (-1.0 if dy < 0 else 0.0)
    mid: List[Point] = []
    if adx >= ady:
        straight = adx - ady
        if straight > 1e-9:
            mid.append([ax + straight * sx, ay])
    else:
        straight = ady - adx
        if straight > 1e-9:
            mid.append([ax, ay + straight * sy])
    mid.append([bx, by])
    return mid


def _line_anchors(
    route: Dict[str, Any],
    hubs: Dict[str, Dict[str, Any]],
    normalize,
    bend_tolerance: float,
) -> List[Dict[str, Any]]:
    """构造单线锚点序列（端点 + 换乘 + 形状折点），按 progress 排序。

    每个锚点：{progress, x, y, stop_idx(或 None), is_station}。
    端点/换乘锚点用其坐标（换乘用全网共享质心），形状折点用 paths.detail 的 RDP 顶点，
    使线路在两锚点间仍能保留真实走向。
    """
    detail = route.get("paths", {}).get("detail") or []
    stops = route.get("stops", [])
    count = len(stops)
    anchors: List[Dict[str, Any]] = []
    station_progress_set: List[float] = []

    for index, stop in enumerate(stops):
        raw_name = str(stop.get("name", ""))
        key = normalize(raw_name) or raw_name
        is_endpoint = index == 0 or index == count - 1
        is_hub = key in hubs
        if not (is_endpoint or is_hub):
            continue
        if is_hub:
            x, y = hubs[key]["x"], hubs[key]["y"]
        else:
            x, y = float(stop["x"]), float(stop["y"])
        progress = float(stop["progress"])
        station_progress_set.append(progress)
        anchors.append({
            "progress": progress, "x": x, "y": y,
            "stop_idx": index, "is_station": True, "hub": key if is_hub else None,
        })

    # 形状折点：paths.detail 的 RDP 简化顶点（去掉首尾，避免与端点重复）
    if len(detail) >= 3:
        bends = rdp(detail, bend_tolerance)
        for vertex in bends[1:-1]:
            progress = project_point_to_path(detail, vertex)["progress"]
            # 跳过离任一站点锚点过近的折点（冗余）
            if any(abs(progress - sp) < 1e-3 for sp in station_progress_set):
                continue
            anchors.append({
                "progress": progress, "x": float(vertex[0]), "y": float(vertex[1]),
                "stop_idx": None, "is_station": False, "hub": None,
            })

    anchors.sort(key=lambda item: item["progress"])
    return anchors


def _route_schematic(
    route: Dict[str, Any],
    hubs: Dict[str, Dict[str, Any]],
    normalize,
    alpha: float,
    bend_tolerance: float,
) -> Dict[str, Any]:
    """单条 forward 线 → schematic 字段（构造性穿过锚点 + α 混合站距）。"""
    anchors = _line_anchors(route, hubs, normalize, bend_tolerance)
    stops = route.get("stops", [])
    count = len(stops)

    # 线路骨架：相邻锚点间走 _octilinear_midpoints，首尾相接
    line_path: List[Point] = [[anchors[0]["x"], anchors[0]["y"]]]
    for index in range(1, len(anchors)):
        a = (anchors[index - 1]["x"], anchors[index - 1]["y"])
        b = (anchors[index]["x"], anchors[index]["y"])
        line_path.extend(_octilinear_midpoints(a, b))
    line_path = merge_collinear(line_path)

    _, total = path_metrics(line_path)

    # 每个站点锚点在线路上的弧长（投影；骨架穿过该点故近似精确）
    station_anchors = [item for item in anchors if item["is_station"]]
    for item in station_anchors:
        item["_arc"] = project_point_to_path(line_path, (item["x"], item["y"]))["progress"] * total

    station_progress = reflow_station_progress(
        stops,
        [int(item["stop_idx"]) for item in station_anchors],
        [float(item["_arc"]) / total if total else 0.0 for item in station_anchors],
        alpha,
    )

    anchor_indices = sorted({item["stop_idx"] for item in station_anchors if item["stop_idx"] is not None})
    return {
        "path": [[round(p[0], 2), round(p[1], 2)] for p in line_path],
        "station_progress": [round(p, 6) for p in station_progress],
        "anchor_indices": anchor_indices,
        "bbox": [round(v, 2) for v in bbox_of(line_path)],
    }


def reflow_station_progress(
    stops: Sequence[Mapping[str, Any]],
    anchor_indexes: Sequence[int],
    anchor_progresses: Sequence[float],
    alpha: float,
) -> List[float]:
    """Blend real/even station spacing between trusted path anchors.

    Studio's ``authoring/layout-math.js`` consumes the same JSON fixtures and
    mirrors this pure calculation for immediate previews.  Persistence always
    runs Python validation again.
    """

    count = len(stops)
    if count < 2 or len(anchor_indexes) < 2 or len(anchor_indexes) != len(anchor_progresses):
        return []
    ratio = clamp(float(alpha), 0.0, 1.0)
    output = [0.0] * count
    for segment in range(len(anchor_indexes) - 1):
        start_index = int(anchor_indexes[segment])
        end_index = int(anchor_indexes[segment + 1])
        start_real = float(stops[start_index].get("progress", start_index / (count - 1)))
        end_real = float(stops[end_index].get("progress", end_index / (count - 1)))
        start_arc = float(anchor_progresses[segment])
        end_arc = float(anchor_progresses[segment + 1])
        span_length = end_index - start_index + 1
        for offset in range(span_length):
            station_index = start_index + offset
            station_real = float(stops[station_index].get("progress", station_index / (count - 1)))
            real_relative = (
                clamp((station_real - start_real) / (end_real - start_real), 0.0, 1.0)
                if end_real > start_real
                else 0.0
            )
            even_relative = offset / (span_length - 1) if span_length > 1 else 0.0
            output[station_index] = start_arc + (
                ratio * real_relative + (1.0 - ratio) * even_relative
            ) * (end_arc - start_arc)
    output[0] = 0.0
    minimum_gap = 1e-9
    for index in range(1, count - 1):
        ceiling = 1.0 - (count - 1 - index) * minimum_gap
        output[index] = min(ceiling, max(output[index], output[index - 1] + minimum_gap))
    output[-1] = 1.0
    return output


def build_schematic_network(
    network: Dict[str, Any],
    alpha: float = 0.55,
    bend_tolerance: float = 90.0,
    normalize=_default_normalize,
) -> Dict[str, Any]:
    """为整网每条 forward 线生成 schematic 字段，并写入全网 transfer_anchors。

    - 换乘锚点跨线共享同一坐标（构造性共点）；
    - 线路骨架强制穿过锚点，故共点由构造保证，不依赖事后 snap；
    - 非锚点站按 α 混合 progress（真实站距 ↔ 均匀站距）沿骨架分布。
    """
    routes = [r for r in network.get("routes", []) if r.get("direction") == "forward"]
    hubs = compute_anchors(routes, normalize)

    for route in routes:
        try:
            route["schematic"] = _route_schematic(route, hubs, normalize, alpha, bend_tolerance)
        except (IndexError, KeyError, ZeroDivisionError):
            # 单线异常不影响整网；标记跳过
            route["schematic"] = None

    network["schematic_alpha"] = alpha
    network["transfer_anchors"] = {
        key: {"name": hub["name"], "x": round(hub["x"], 2), "y": round(hub["y"], 2), "lines": hub["lines"]}
        for key, hub in hubs.items()
    }
    return network
