from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin
from xml.etree import ElementTree as ET

import requests
from bs4 import BeautifulSoup

from .config import CATALOG_PATH, DATA_DIR, DB_PATH
from .db import load_catalog

LIST_URL = "https://jtys.sz.gov.cn/zwgk/ztzl/ggqsydw/jt/gj/ywxx/gjlx/"
NS = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def column_index(cell_ref: str) -> int:
    letters = "".join(ch for ch in cell_ref if ch.isalpha()).upper()
    value = 0
    for ch in letters:
        value = value * 26 + ord(ch) - 64
    return max(0, value - 1)


def read_xlsx_rows(path: Path) -> List[List[object]]:
    with zipfile.ZipFile(path) as archive:
        shared_strings: List[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall("a:si", NS):
                text = "".join(node.text or "" for node in item.findall(".//a:t", NS))
                shared_strings.append(text)

        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        first_sheet = workbook.find("a:sheets/a:sheet", NS)
        if first_sheet is None:
            raise RuntimeError("Excel 中没有工作表")
        rel_id = first_sheet.attrib.get(f"{{{DOC_REL_NS}}}id")
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        target = None
        for rel in rels.findall("r:Relationship", REL_NS):
            if rel.attrib.get("Id") == rel_id:
                target = rel.attrib.get("Target")
                break
        if not target:
            raise RuntimeError("无法定位首个工作表")
        sheet_path = "xl/" + target.lstrip("/")
        sheet = ET.fromstring(archive.read(sheet_path))
        output: List[List[object]] = []
        for row in sheet.findall(".//a:sheetData/a:row", NS):
            values: List[object] = []
            for cell in row.findall("a:c", NS):
                index = column_index(cell.attrib.get("r", "A1"))
                while len(values) <= index:
                    values.append(None)
                cell_type = cell.attrib.get("t")
                value_node = cell.find("a:v", NS)
                if cell_type == "inlineStr":
                    text = "".join(node.text or "" for node in cell.findall(".//a:t", NS))
                    value: object = text
                elif value_node is None:
                    value = None
                elif cell_type == "s":
                    value = shared_strings[int(value_node.text or 0)]
                elif cell_type in {"str", "e"}:
                    value = value_node.text or ""
                else:
                    raw = value_node.text or ""
                    try:
                        number = float(raw)
                        value = int(number) if number.is_integer() else number
                    except ValueError:
                        value = raw
                values[index] = value
            output.append(values)
        return output


def split_stops(value: object) -> List[str]:
    text = str(value or "").strip()
    if not text or text in {"/", "／", "无", "-"}:
        return []
    return [item.strip() for item in re.split(r"[、,，;；]+", text) if item.strip()]


def routes_from_xlsx(path: Path, source_title: str = "") -> dict:
    rows = read_xlsx_rows(path)
    header_index = next(
        (
            index
            for index, row in enumerate(rows)
            if len(row) >= 7 and str(row[0] or "").strip() == "序号" and "线路" in str(row[2] or "")
        ),
        None,
    )
    if header_index is None:
        raise RuntimeError("未识别到“序号/业户名称/线路编号/上行途经站点”表头")
    title = source_title or str(rows[0][0] or path.stem)
    routes = []
    for row in rows[header_index + 1 :]:
        if not row or row[0] is None:
            continue
        row = row + [None] * max(0, 7 - len(row))
        try:
            route_id = int(row[0])
        except (TypeError, ValueError):
            continue
        route_no = str(row[2] or "").strip()
        if route_no.endswith(".0") and route_no[:-2].isdigit():
            route_no = route_no[:-2]
        up = split_stops(row[5])
        down = split_stops(row[6])
        directions = []
        if up:
            directions.append(
                {
                    "direction": "up",
                    "label": "上行",
                    "stops": up,
                    "start_stop": up[0],
                    "end_stop": up[-1],
                }
            )
        if down:
            directions.append(
                {
                    "direction": "down",
                    "label": "下行",
                    "stops": down,
                    "start_stop": down[0],
                    "end_stop": down[-1],
                }
            )
        route = {
            "id": route_id,
            "operator": str(row[1] or "").strip(),
            "route_no": route_no,
            "start_stop": str(row[3] or "").strip(),
            "end_stop": str(row[4] or "").strip(),
            "directions": directions,
        }
        route["fingerprint"] = hashlib.sha256(
            json.dumps(route, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        routes.append(route)
    return {"source_title": title, "route_count": len(routes), "routes": routes}


def discover_latest(session: requests.Session) -> Tuple[str, str, str]:
    response = session.get(LIST_URL, timeout=30)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    page_url = None
    for link in soup.select("a[href]"):
        href = link.get("href", "")
        if "content/post_" in href:
            page_url = urljoin(LIST_URL, href)
            break
    if not page_url:
        raise RuntimeError("未在公交线路栏目找到最新公告")
    response = session.get(page_url, timeout=30)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    xlsx_url = None
    xlsx_title = ""
    for link in soup.select("a[href]"):
        href = link.get("href", "")
        if ".xlsx" in href.lower():
            xlsx_url = urljoin(page_url, href)
            xlsx_title = link.get_text(" ", strip=True)
            break
    if not xlsx_url:
        raise RuntimeError("最新公告中没有找到 .xlsx 附件")
    published = ""
    text = soup.get_text(" ", strip=True)
    match = re.search(r"发布时间[:：]\s*(\d{4}-\d{2}-\d{2})", text)
    if match:
        published = match.group(1)
    return page_url, xlsx_url, published or ""


def sync(xlsx_path: Optional[Path] = None) -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    existing_meta = {}
    if CATALOG_PATH.exists():
        try:
            existing_meta = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing_meta = {}
    published = ""
    source_page = ""
    source_file = DATA_DIR / "source.xlsx"
    if xlsx_path:
        source_resolved = xlsx_path.resolve()
        target_resolved = source_file.resolve()
        if source_resolved != target_resolved:
            shutil.copy2(source_resolved, target_resolved)
    else:
        session = requests.Session()
        session.headers["User-Agent"] = "Mozilla/5.0 ShenzhenBusNetwork/1.0"
        source_page, xlsx_url, published = discover_latest(session)
        response = session.get(xlsx_url, timeout=60)
        response.raise_for_status()
        source_file.write_bytes(response.content)

    catalog = routes_from_xlsx(source_file)
    title_match = re.search(r"(\d{4})年(\d{1,2})月", catalog["source_title"])
    if title_match:
        catalog["source_date"] = f"{title_match.group(1)}-{int(title_match.group(2)):02d}"
    else:
        catalog["source_date"] = ""
    catalog["published_at"] = published or existing_meta.get("published_at", "")
    catalog["source_page"] = source_page or existing_meta.get("source_page", "")
    CATALOG_PATH.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    db_result = load_catalog(CATALOG_PATH, DB_PATH)
    return {
        "xlsx": str(source_file),
        "catalog": str(CATALOG_PATH),
        "route_count": catalog["route_count"],
        "source_title": catalog["source_title"],
        "database": db_result,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="同步深圳官方公交线路 Excel")
    parser.add_argument("--xlsx", type=Path, help="使用本地 Excel，不联网发现最新公告")
    args = parser.parse_args()
    print(json.dumps(sync(args.xlsx), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
