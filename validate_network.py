from __future__ import annotations

import argparse
import gzip
import json
import math
from pathlib import Path
from typing import Any, Dict, List

from build_network import DATA_DIR, focus_self_intersections


def validate(network_path: Path, data_dir: Path) -> Dict[str, Any]:
    with gzip.open(network_path, "rt", encoding="utf-8") as handle:
        network = json.load(handle)

    errors: List[str] = []
    max_angle_error = 0.0
    long_routes = 0
    for route in network.get("routes", []):
        route_id = str(route.get("id", "?"))
        stops = route.get("stops", [])
        focus = route.get("geometry", {}).get("focus", {})
        path = focus.get("path", [])
        progresses = focus.get("stationProgresses", [])
        gcj02 = route.get("geometry", {}).get("gcj02", {}).get("path", [])
        if len(stops) > 45:
            long_routes += 1
        if len(path) != len(stops) or len(progresses) != len(stops):
            errors.append(f"{route_id}: focus/stops 长度不一致")
            continue
        if len(path) >= 2:
            if not all(left < right for left, right in zip(progresses, progresses[1:])):
                errors.append(f"{route_id}: focus progress 非严格单调")
            if abs(float(progresses[-1]) - 1.0) > 1e-6:
                errors.append(f"{route_id}: focus 终点 progress 不为 1")
            intersections = focus_self_intersections([tuple(point) for point in path])
            if intersections:
                errors.append(f"{route_id}: focus 自交 {intersections} 次")
            for start, end in zip(path, path[1:]):
                angle = math.atan2(end[1] - start[1], end[0] - start[0])
                snapped = round(angle / (math.pi / 4)) * (math.pi / 4)
                angle_error = abs(
                    math.atan2(math.sin(angle - snapped), math.cos(angle - snapped))
                )
                max_angle_error = max(max_angle_error, angle_error)
                if angle_error > 0.001:
                    errors.append(f"{route_id}: focus 存在非八方向线段")
                    break
        if len(gcj02) < 2:
            errors.append(f"{route_id}: 缺少 GCJ-02 线路")
        if any(len(stop.get("gcj02", [])) != 2 for stop in stops):
            errors.append(f"{route_id}: 缺少 GCJ-02 站点")

    manifest_path = data_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    route_files = list((data_dir / "bus" / "routes").glob("*.json.gz"))
    if len(manifest.get("routes", [])) != len(network.get("routes", [])):
        errors.append("manifest 线路数量与 network 不一致")
    if len(route_files) < len(network.get("routes", [])):
        errors.append("单线分片数量不足")

    return {
        "ok": not errors,
        "version": network.get("version"),
        "directions": len(network.get("routes", [])),
        "long_routes": long_routes,
        "focus_fallbacks": network.get("stats", {}).get("focus_fallbacks", 0),
        "max_angle_error_degrees": round(math.degrees(max_angle_error), 6),
        "manifest_routes": len(manifest.get("routes", [])),
        "route_files": len(route_files),
        "errors": errors[:30],
        "error_count": len(errors),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="校验公交发布数据与 focusGeometry")
    parser.add_argument("--network", type=Path, default=DATA_DIR / "network.json.gz")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    args = parser.parse_args()
    result = validate(args.network, args.data_dir)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
