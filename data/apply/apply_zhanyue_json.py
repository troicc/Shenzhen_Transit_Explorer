#!/usr/bin/env python3
"""
把 metro.export_zhanyue 导出的 JSON 嵌入站粤 v3 index.html。

示例：

1. 生成新文件：
   python apply_zhanyue_json.py \
       --json data/zhanyue_metro_data.json \
       --html zhanyue/index.html

2. 直接覆盖 index.html，并备份为 index.html.bak：
   python apply_zhanyue_json.py \
       --json data/zhanyue_metro_data.json \
       --html zhanyue/index.html \
       --in-place \
       --version-storage-key

`--version-storage-key` 会把 zhanyue-review-v3 改成带数据版本的键，
防止浏览器中旧的人工校核数据覆盖刚嵌入的新 DATA。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any


DATA_START_RE = re.compile(r"\blet\s+DATA\s*=", re.MULTILINE)
LINES_MARKER_RE = re.compile(
    r"\blet\s+LINES\s*=\s*DATA\.lines\s*;",
    re.MULTILINE,
)
BASE_STORAGE_KEY = "zhanyue-review-v3"


def load_and_validate_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"找不到 JSON：{path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"JSON 格式错误：{path}:{exc.lineno}:{exc.colno}：{exc.msg}"
        ) from exc

    if not isinstance(data, dict):
        raise SystemExit("JSON 顶层必须是对象。")

    lines = data.get("lines")
    if not isinstance(lines, list) or not lines:
        raise SystemExit("JSON 必须包含非空的顶层 lines 数组。")

    required_line_fields = {"id", "name", "color", "d", "stations"}
    required_station_fields = {"name", "progress"}

    for line_index, line in enumerate(lines):
        if not isinstance(line, dict):
            raise SystemExit(f"lines[{line_index}] 必须是对象。")

        missing = required_line_fields - line.keys()
        if missing:
            raise SystemExit(
                f"lines[{line_index}] 缺少字段：{', '.join(sorted(missing))}"
            )

        if not isinstance(line["d"], str) or not line["d"].lstrip().startswith("M"):
            raise SystemExit(f"lines[{line_index}].d 不是有效的 SVG 路径字符串。")

        stations = line["stations"]
        if not isinstance(stations, list):
            raise SystemExit(f"lines[{line_index}].stations 必须是数组。")

        previous_progress = -1.0
        for station_index, station in enumerate(stations):
            if not isinstance(station, dict):
                raise SystemExit(
                    f"lines[{line_index}].stations[{station_index}] 必须是对象。"
                )

            missing_station = required_station_fields - station.keys()
            if missing_station:
                raise SystemExit(
                    f"lines[{line_index}].stations[{station_index}] 缺少字段："
                    f"{', '.join(sorted(missing_station))}"
                )

            try:
                progress = float(station["progress"])
            except (TypeError, ValueError) as exc:
                raise SystemExit(
                    f"lines[{line_index}].stations[{station_index}].progress "
                    "必须是数字。"
                ) from exc

            if not 0.0 <= progress <= 1.0:
                raise SystemExit(
                    f"lines[{line_index}].stations[{station_index}].progress "
                    f"超出 0..1：{progress}"
                )

            if progress < previous_progress:
                raise SystemExit(
                    f"线路 {line.get('name', line_index)} 的 progress 不是递增顺序。"
                )
            previous_progress = progress

    return data


def serialize_for_inline_script(data: dict[str, Any], pretty: bool) -> str:
    if pretty:
        text = json.dumps(data, ensure_ascii=False, indent=2)
    else:
        text = json.dumps(
            data,
            ensure_ascii=False,
            separators=(",", ":"),
        )

    # 防止 JSON 字符串中的 </script> 提前结束 HTML 的 script 标签。
    return re.sub(r"</script", r"<\/script", text, flags=re.IGNORECASE)


def replace_embedded_data(html: str, data_js: str) -> str:
    data_match = DATA_START_RE.search(html)
    if not data_match:
        raise SystemExit("在 HTML 中找不到 `let DATA = ...`。")

    lines_match = LINES_MARKER_RE.search(html, data_match.end())
    if not lines_match:
        raise SystemExit(
            "在 DATA 后找不到 `let LINES = DATA.lines;`，"
            "无法安全确定替换边界。"
        )

    replacement = f"let DATA = {data_js};\n"
    return html[: data_match.start()] + replacement + html[lines_match.start() :]


def build_storage_key(data: dict[str, Any], json_bytes: bytes) -> str:
    version = str(data.get("mapVersion") or "").strip()
    digest = hashlib.sha256(json_bytes).hexdigest()[:10]

    if version:
        safe_version = re.sub(r"[^0-9A-Za-z._-]+", "-", version).strip("-")
        if safe_version:
            return f"{BASE_STORAGE_KEY}-{safe_version}-{digest}"

    return f"{BASE_STORAGE_KEY}-{digest}"


def version_storage_key(html: str, new_key: str) -> tuple[str, int]:
    double_quoted = f'"{BASE_STORAGE_KEY}"'
    single_quoted = f"'{BASE_STORAGE_KEY}'"

    count = html.count(double_quoted) + html.count(single_quoted)
    html = html.replace(double_quoted, f'"{new_key}"')
    html = html.replace(single_quoted, f"'{new_key}'")
    return html, count


def resolve_output_path(html_path: Path, output: Path | None, in_place: bool) -> Path:
    if in_place:
        return html_path
    if output is not None:
        return output
    return html_path.with_name(f"{html_path.stem}.with-data{html_path.suffix}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把站粤导出 JSON 嵌入站粤 v3 index.html"
    )
    parser.add_argument("--json", required=True, type=Path, help="导出的 JSON 文件")
    parser.add_argument("--html", required=True, type=Path, help="站粤 v3 index.html")
    parser.add_argument("--output", type=Path, help="输出 HTML；默认 *.with-data.html")
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="直接覆盖 --html，并自动生成 .bak 备份",
    )
    parser.add_argument(
        "--version-storage-key",
        action="store_true",
        help="使用带版本的 localStorage 键，避免旧校核缓存覆盖新 DATA",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="在 HTML 中保留缩进后的 JSON，便于查看但文件更大",
    )
    args = parser.parse_args()

    if args.in_place and args.output:
        parser.error("--in-place 与 --output 不能同时使用。")

    json_path = args.json.resolve()
    html_path = args.html.resolve()

    if not html_path.exists():
        raise SystemExit(f"找不到 HTML：{html_path}")

    json_bytes = json_path.read_bytes()
    data = load_and_validate_json(json_path)
    html = html_path.read_text(encoding="utf-8")

    data_js = serialize_for_inline_script(data, pretty=args.pretty)
    result = replace_embedded_data(html, data_js)

    storage_key = None
    storage_replacements = 0
    if args.version_storage_key:
        storage_key = build_storage_key(data, json_bytes)
        result, storage_replacements = version_storage_key(result, storage_key)
        if storage_replacements == 0:
            print(
                "警告：未找到基础 localStorage 键 "
                f"{BASE_STORAGE_KEY!r}，DATA 仍会正常替换。",
                file=sys.stderr,
            )

    output_path = resolve_output_path(html_path, args.output, args.in_place)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if args.in_place:
        backup_path = html_path.with_suffix(html_path.suffix + ".bak")
        shutil.copy2(html_path, backup_path)
        print(f"已备份：{backup_path}")

    output_path.write_text(result, encoding="utf-8")

    line_count = len(data["lines"])
    station_count = sum(len(line.get("stations", [])) for line in data["lines"])

    print(f"已写入：{output_path}")
    print(f"线路：{line_count}，站点记录：{station_count}")
    print(f"内置数据版本：{data.get('mapVersion', '未提供')}")

    if storage_key:
        print(
            f"localStorage 键：{storage_key} "
            f"（替换 {storage_replacements} 处）"
        )
    else:
        print(
            "提示：若页面仍显示旧数据，请清除浏览器中的 "
            f"{BASE_STORAGE_KEY}，或重新执行时加 --version-storage-key。"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
