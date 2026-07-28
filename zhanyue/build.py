"""Build the internal review artifact and the hardened public artifact."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .public_assets import audit_public_bundle, build_public_derivatives


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_DIR = Path(__file__).resolve().parent
SRC_DIR = PACKAGE_DIR / "src"
DEFAULT_DATA = ROOT / "data" / "zhanyue_metro_data.json"
DEFAULT_DIST = PACKAGE_DIR / "dist"
BUILD_FORMAT_VERSION = "2026-07-28.5"
DEFAULT_GEOGRAPHIC_DATA = ROOT / "data" / "metro_network.json.gz"


def load_data(path: Path) -> Tuple[Dict[str, Any], bytes]:
    try:
        raw = path.read_bytes()
    except FileNotFoundError as exc:
        raise SystemExit(f"找不到站粤数据：{path}\n请先运行 python -m metro.export_zhanyue") from exc
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SystemExit(f"站粤数据不是有效 UTF-8 JSON：{path}: {exc}") from exc
    lines = data.get("lines") if isinstance(data, dict) else None
    if not isinstance(lines, list) or not lines:
        raise SystemExit("站粤数据必须包含非空 lines 数组")
    seen = set()
    for line in lines:
        required = {"id", "name", "color", "d", "stations"}
        if not isinstance(line, dict) or not required.issubset(line):
            raise SystemExit("每条线路必须包含 id/name/color/d/stations")
        line_id = str(line["id"])
        if line_id in seen:
            raise SystemExit(f"线路 id 重复：{line_id}")
        seen.add(line_id)
        previous = -1.0
        for station in line["stations"]:
            progress = float(station.get("progress", -1))
            if not 0 <= progress <= 1 or progress < previous:
                raise SystemExit(f"{line['name']} 的站点 progress 非法或未递增")
            previous = progress
    return data, raw


def read_source_order(path: Path) -> Dict[str, List[str]]:
    sections: Dict[str, List[str]] = {}
    current = ""
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1]
            sections[current] = []
        elif current:
            sections[current].append(line)
    return sections


def inline_style(name: str, content: str) -> str:
    return f'<style data-zhanyue-module="{name}">\n{content.rstrip()}\n</style>'


def inline_script(name: str, content: str) -> str:
    return f'<script data-zhanyue-module="{name}">\n{content.rstrip()}\n</script>'


def storage_key(data: Dict[str, Any], raw: bytes) -> str:
    version = re.sub(r"[^0-9A-Za-z._-]+", "-", str(data.get("mapVersion") or "")).strip("-")
    digest = hashlib.sha256(raw).hexdigest()[:12]
    return f"zhanyue-review-v3-{version + '-' if version else ''}{digest}"


def build_review(data: Dict[str, Any], raw: bytes, output: Path) -> Dict[str, Any]:
    source = SRC_DIR / "review"
    order = read_source_order(source / "source-order.txt")
    template = (source / "index.template.html").read_text(encoding="utf-8")
    styles = [
        inline_style(name, (source / "styles" / name).read_text(encoding="utf-8"))
        for name in order["styles"]
    ]
    runtime_parts = [
        f"/* module: {name} */\n" + (source / "runtime" / name).read_text(encoding="utf-8")
        for name in order["runtime"]
    ]
    key = storage_key(data, raw)
    runtime = "\n".join(runtime_parts)
    runtime = re.sub(r"zhanyue-review-v3(?:-[0-9A-Za-z._-]+)?", key, runtime)
    data_js = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</script", "<\\/script")
    scripts = [
        inline_script("data", f"let DATA = {data_js};\nlet LINES = DATA.lines;"),
        inline_script("runtime", runtime),
    ]
    for name in order["features"]:
        content = (source / "features" / name).read_text(encoding="utf-8")
        scripts.append(inline_script(name, content))
    build_id = "review-" + hashlib.sha256(raw + runtime.encode("utf-8") + BUILD_FORMAT_VERSION.encode("ascii")).hexdigest()[:16]
    html = template.replace("<!-- ZHANYUE_STYLES -->", "\n".join(styles))
    html = html.replace("<!-- ZHANYUE_SCRIPTS -->", "\n".join(scripts))
    html = re.sub(r'<meta name="zhanyue-build" content="[^"]*">', f'<meta name="zhanyue-build" content="{build_id}">', html)
    output.mkdir(parents=True, exist_ok=True)
    (output / "index.html").write_text(html, encoding="utf-8")
    return {"buildId": build_id, "storageKey": key, "bytes": len(html.encode("utf-8"))}


def minify_css(css: str) -> str:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    css = re.sub(r"\s+", " ", css)
    css = re.sub(r"\s*([{}:;,>])\s*", r"\1", css)
    return css.strip()


def parse_path(path_d: str) -> List[Tuple[float, float]]:
    tokens = re.findall(r"[ML]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?", path_d, flags=re.IGNORECASE)
    points: List[Tuple[float, float]] = []
    index = 0
    while index < len(tokens):
        if tokens[index].upper() not in {"M", "L"}:
            raise SystemExit("概览图仅支持 M/L SVG 路径")
        points.append((float(tokens[index + 1]), float(tokens[index + 2])))
        index += 3
    return points


def _font(size: int, bold: bool = False):
    from PIL import ImageFont

    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size=size, index=0)
            except OSError:
                pass
    return ImageFont.load_default()


def build_overview_image(data: Dict[str, Any], output: Path, build_id: str) -> None:
    try:
        from PIL import Image, ImageDraw, PngImagePlugin
    except ImportError as exc:
        raise SystemExit("生成公开概览图需要 Pillow：pip install Pillow") from exc

    width, height = 1920, 1080
    image = Image.new("RGB", (width, height), "#07101d")
    draw = ImageDraw.Draw(image, "RGBA")
    all_points = [point for line in data["lines"] for point in parse_path(str(line["d"]))]
    min_x = min(point[0] for point in all_points); max_x = max(point[0] for point in all_points)
    min_y = min(point[1] for point in all_points); max_y = max(point[1] for point in all_points)
    margin_x, margin_y = 170, 120
    scale = min((width - margin_x * 2) / max(1, max_x - min_x), (height - margin_y * 2) / max(1, max_y - min_y))
    offset_x = margin_x + ((width - margin_x * 2) - (max_x - min_x) * scale) / 2
    offset_y = margin_y + ((height - margin_y * 2) - (max_y - min_y) * scale) / 2

    def project(point: Tuple[float, float]) -> Tuple[int, int]:
        return (round(offset_x + (point[0] - min_x) * scale), round(offset_y + (point[1] - min_y) * scale))

    for x in range(0, width, 96):
        draw.line([(x, 0), (x, height)], fill=(145, 185, 220, 11), width=1)
    for y in range(0, height, 96):
        draw.line([(0, y), (width, y)], fill=(145, 185, 220, 11), width=1)
    for line in data["lines"]:
        points = [project(point) for point in parse_path(str(line["d"]))]
        draw.line(points, fill=(1, 7, 13, 230), width=18, joint="curve")
        color = str(line.get("color", "#5cc8ff")).lstrip("#")
        rgb = tuple(int(color[index : index + 2], 16) for index in (0, 2, 4)) if len(color) == 6 else (92, 200, 255)
        draw.line(points, fill=rgb + (220,), width=9, joint="curve")
        for station in line.get("stations", []):
            x, y = float(station.get("x", 0)), float(station.get("y", 0))
            px, py = project((x, y))
            radius = 7 if station.get("transfer") else 4
            draw.ellipse((px - radius, py - radius, px + radius, py + radius), fill=(239, 249, 255, 235), outline=rgb + (255,), width=2)

    small_font = _font(18)
    draw.text(
        (width - 540, height - 42),
        f"站粤 · 人工复核示意 · 非官方产品 · build {build_id[-8:]}",
        font=small_font,
        fill=(126, 178, 216, 210),
    )
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Copyright", "Zhanyue. All rights reserved. Unauthorized vector reconstruction prohibited.")
    metadata.add_text("BuildId", build_id)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, format="PNG", optimize=True, pnginfo=metadata)


def build_public(
    data: Dict[str, Any],
    raw: bytes,
    output: Path,
    geographic_path: Optional[Path] = None,
) -> Dict[str, Any]:
    source = SRC_DIR / "public"
    template = (source / "index.template.html").read_text(encoding="utf-8")
    css = minify_css((source / "app.css").read_text(encoding="utf-8"))
    module_paths = sorted((source / "modules").glob("*.js"))
    bundle = "\n".join(path.read_text(encoding="utf-8") for path in module_paths).replace("</script", "<\\/script")
    asset_builder = (PACKAGE_DIR / "public_assets.py").read_bytes()
    geographic_source = geographic_path if geographic_path is not None else DEFAULT_GEOGRAPHIC_DATA
    geographic_fingerprint = geographic_source.read_bytes() if geographic_source.exists() else b""
    build_id = "public-" + hashlib.sha256(
        raw
        + bundle.encode("utf-8")
        + css.encode("utf-8")
        + template.encode("utf-8")
        + asset_builder
        + geographic_fingerprint
        + BUILD_FORMAT_VERSION.encode("ascii")
    ).hexdigest()[:16]
    # The old XOR/Base64 wrapper did not create a security boundary: both the
    # ciphertext and key were shipped to the browser.  A minified, unhashed
    # source map-free bundle is easier to audit, while asset protection is now
    # enforced by the derivative data pipeline.
    bootstrap = bundle
    script_hash = base64.b64encode(hashlib.sha256(bootstrap.encode("utf-8")).digest()).decode("ascii")
    csp = (
        "default-src 'self'; "
        "img-src 'self' data: https://*.amap.com; "
        "style-src 'self' 'unsafe-inline' https://*.amap.com; "
        f"script-src 'sha256-{script_hash}' blob: https://webapi.amap.com https://*.amap.com; "
        "connect-src 'self' https://*.amap.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    )
    html = template.replace("__ZHANYUE_BUILD_ID__", build_id)
    html = html.replace("__ZHANYUE_CSP__", csp)
    html = html.replace("__ZHANYUE_CSS__", css)
    html = html.replace("__ZHANYUE_BOOTSTRAP__", bootstrap)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)
    (output / "index.html").write_text(html, encoding="utf-8")
    build_overview_image(data, output / "assets" / "network-overview.png", build_id)
    derivatives = build_public_derivatives(
        data,
        output,
        build_id,
        geographic_source if geographic_source.exists() else None,
    )
    violations = audit_public_bundle(output)
    if violations:
        raise SystemExit("公开部署包安全审计失败：\n- " + "\n- ".join(violations))
    return {
        "buildId": build_id,
        "bytes": len(html.encode("utf-8")),
        "bundleModules": len(module_paths),
        "derivatives": derivatives,
        "audit": "passed",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="构建站粤内部校核版和公开只读版")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--dist", type=Path, default=DEFAULT_DIST)
    parser.add_argument(
        "--geographic-data",
        type=Path,
        default=DEFAULT_GEOGRAPHIC_DATA,
        help="包含 GCJ-02 geometry 的地理线网；只在受信构建机读取",
    )
    parser.add_argument("--mode", choices=["all", "review", "public"], default="all")
    args = parser.parse_args()
    data, raw = load_data(args.data.resolve())
    dist = args.dist.resolve()
    results: Dict[str, Any] = {
        "data": str(args.data.resolve()),
        "mapVersion": data.get("mapVersion"),
        "lines": len(data["lines"]),
        "stationRecords": sum(len(line.get("stations", [])) for line in data["lines"]),
    }
    if args.mode in {"all", "review"}:
        results["review"] = build_review(data, raw, dist / "review")
    if args.mode in {"all", "public"}:
        results["public"] = build_public(data, raw, dist / "public", args.geographic_data.resolve())
    (dist / "build.json").parent.mkdir(parents=True, exist_ok=True)
    (dist / "build.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
