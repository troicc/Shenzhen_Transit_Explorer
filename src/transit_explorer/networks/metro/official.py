from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from bs4 import BeautifulSoup

from .config import LINE_COLORS, OFFICIAL_PATH, SEED_PATH, SOURCE_URL

ROUTE_RE = re.compile(r"^(?:\d+号线(?:支线)?|\d+号线\s*[&＆/]\s*\d+号线)$")
STOPS_RE = re.compile(r"^沿途站点[：:](.+?)[。.]?$")
DATE_RE = re.compile(r"发布时间[：:]?\s*(\d{4}-\d{2}-\d{2})")


def clean_line(value: str) -> str:
    value = value.replace("\u3000", " ").replace("\xa0", " ")
    return re.sub(r"\s+", "", value).strip()


def canonical_route_name(value: str) -> str:
    value = clean_line(value).replace("＆", "&").replace("/", "&")
    if value in ("2号线&8号线", "8号线&2号线"):
        return "2号线&8号线"
    return value


def route_id(name: str) -> str:
    if name == "2号线&8号线":
        return "metro-2-8"
    number_match = re.search(r"(\d+)", name)
    if not number_match:
        raise ValueError("无法识别地铁线路名称：{}".format(name))
    suffix = "-branch" if "支线" in name else ""
    return "metro-{}{}".format(number_match.group(1), suffix)


def aliases_for(name: str) -> List[str]:
    if name == "2号线&8号线":
        return [
            "深圳地铁2号线",
            "深圳地铁8号线",
            "地铁2号线",
            "地铁8号线",
            "2号线&8号线",
        ]
    return ["深圳地铁{}".format(name), "地铁{}".format(name), name]


def short_name(name: str) -> str:
    if name == "2号线&8号线":
        return "2/8"
    matched = re.search(r"(\d+)", name)
    if not matched:
        return name
    return matched.group(1) + ("支" if "支线" in name else "")


def parse_official_html(html: str, source_url: str = SOURCE_URL) -> Dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    page_text = soup.get_text("\n")
    raw_lines = [clean_line(line) for line in page_text.splitlines()]
    lines = [line for line in raw_lines if line]

    source_date = ""
    date_match = DATE_RE.search(page_text.replace("\u3000", " "))
    if date_match:
        source_date = date_match.group(1)

    routes: List[Dict[str, Any]] = []
    current: Optional[str] = None
    for line in lines:
        possible = canonical_route_name(line)
        if ROUTE_RE.fullmatch(possible):
            current = possible
            continue
        stop_match = STOPS_RE.fullmatch(line)
        if current and stop_match:
            stations = [
                item.strip()
                for item in re.split(r"[—－–-]", stop_match.group(1))
                if item.strip()
            ]
            if len(stations) < 2:
                current = None
                continue
            routes.append(
                {
                    "id": route_id(current),
                    "name": current,
                    "short_name": short_name(current),
                    "color": LINE_COLORS.get(current, "#7da6c8"),
                    "aliases": aliases_for(current),
                    "stations": stations,
                    "origin": stations[0],
                    "destination": stations[-1],
                }
            )
            current = None

    if len(routes) < 10:
        raise RuntimeError("官方页面解析结果异常，仅得到 {} 条线路".format(len(routes)))

    return {
        "network_id": "sz-metro",
        "name": "深圳地铁",
        "source_url": source_url,
        "source_date": source_date,
        "routes": routes,
    }


def payload_fingerprint(payload: Dict[str, Any]) -> str:
    value = json.dumps(payload.get("routes", []), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sync(output_path: Path = OFFICIAL_PATH, timeout: int = 30) -> Dict[str, Any]:
    response = requests.get(
        SOURCE_URL,
        timeout=timeout,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; ShenzhenMetroCollector/1.0)",
            "Accept-Language": "zh-CN,zh;q=0.9",
        },
    )
    response.raise_for_status()
    response.encoding = response.apparent_encoding or "utf-8"
    payload = parse_official_html(response.text, SOURCE_URL)
    payload["fingerprint"] = payload_fingerprint(payload)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def ensure_official(path: Path = OFFICIAL_PATH) -> Dict[str, Any]:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    if SEED_PATH.exists():
        payload = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        payload["fingerprint"] = payload_fingerprint(payload)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return payload
    return sync(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="同步深圳交通运输局地铁官方线路及站序")
    parser.add_argument("--output", type=Path, default=OFFICIAL_PATH)
    parser.add_argument("--seed", action="store_true", help="不联网，使用包内官方数据种子")
    args = parser.parse_args()
    if args.seed:
        payload = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        payload["fingerprint"] = payload_fingerprint(payload)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        payload = sync(args.output)
    print(json.dumps({
        "output": str(args.output),
        "source_date": payload.get("source_date"),
        "routes": len(payload.get("routes", [])),
        "stations": sum(len(item.get("stations", [])) for item in payload.get("routes", [])),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
