from __future__ import annotations

import gzip
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from dotenv import load_dotenv
from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from language_data import StationLanguageStore

from .build_network import build as build_metro_network
from .constants import DATA_DIR, DB_PATH, NETWORK_PATH, OFFICIAL_PATH, ROOT, STATIC_DIR
from .db import (
    choose_candidate,
    get_queue,
    get_review_list,
    get_route_item,
    get_stats,
    initialize,
    load_official,
    reset_routes,
    store_query_result,
)
from .matcher import normalize_name
from .official_sync import sync as sync_official

load_dotenv(ROOT / ".env")
router = APIRouter(tags=["深圳地铁采集与线网"])
_init_lock = threading.Lock()
_initialized = False
LANGUAGE_PATH = DATA_DIR / "station_language.json"
LAYOUT_PATH = DATA_DIR / "metro_schematic_layout.json"
language_store = StationLanguageStore(LANGUAGE_PATH)


class MetroCollectorResult(BaseModel):
    route_id: str
    status: str
    info: str = ""
    candidates: List[Dict[str, Any]] = Field(default_factory=list)
    error: Optional[str] = None


class MetroChooseRequest(BaseModel):
    route_id: str
    candidate_id: int
    reversed: Optional[bool] = None


class MetroResetRequest(BaseModel):
    statuses: List[str]


class MetroLanguageRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    pinyin: Optional[str] = Field(default=None, max_length=300)
    jyutping: Optional[str] = Field(default=None, max_length=300)
    audio_url: Optional[str] = Field(default=None, max_length=1000)
    note: Optional[str] = Field(default=None, max_length=1000)


class NetworkCache:
    def __init__(self, path: Path):
        self.path = path
        self.mtime = -1.0
        self.data: Optional[Dict[str, Any]] = None
        self.route_map: Dict[str, Dict[str, Any]] = {}
        self.lock = threading.Lock()

    def clear(self) -> None:
        with self.lock:
            self.mtime = -1.0
            self.data = None
            self.route_map = {}

    def get(self) -> Dict[str, Any]:
        if not self.path.exists():
            raise FileNotFoundError(str(self.path))
        mtime = self.path.stat().st_mtime
        if self.data is None or mtime != self.mtime:
            with self.lock:
                mtime = self.path.stat().st_mtime
                if self.data is None or mtime != self.mtime:
                    with gzip.open(str(self.path), "rt", encoding="utf-8") as handle:
                        self.data = json.load(handle)
                    self.mtime = mtime
                    self.route_map = {
                        str(item["id"]): item for item in self.data.get("routes", [])
                    }
        return self.data


network_cache = NetworkCache(NETWORK_PATH)


def ensure_initialized() -> None:
    global _initialized
    if _initialized:
        return
    with _init_lock:
        if not _initialized:
            initialize(DB_PATH)
            _initialized = True


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------


@router.get("/metro")
def metro_network_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "metro_index.html")


@router.get("/metro/studio")
def metro_studio_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "metro_studio.html")


@router.get("/metro/learn")
def metro_learn_page() -> FileResponse:
    # Bus and metro intentionally share one product shell.  The API module
    # selects the network from the /metro/learn path without forking the UI.
    response = FileResponse(STATIC_DIR / "learn.html")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


@router.get("/metro/collector")
def metro_collector_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "metro_collector.html")


@router.get("/metro-collector")
def metro_collector_alias() -> RedirectResponse:
    return RedirectResponse(url="/metro/collector", status_code=307)


# ---------------------------------------------------------------------------
# Collection and build APIs
# ---------------------------------------------------------------------------


@router.get("/api/metro/config")
def metro_config() -> Dict[str, Any]:
    key = os.getenv("AMAP_JS_KEY", "").strip()
    security = os.getenv("AMAP_SECURITY_CODE", "").strip()
    return {
        "amap_js_key": key,
        "amap_security_code": security,
        "ready": bool(key and security),
        "city": os.getenv("AMAP_CITY", "深圳"),
        "default_delay_ms": int(os.getenv("COLLECT_DELAY_MS", "1200")),
    }


@router.get("/api/metro/status")
def metro_status() -> Dict[str, Any]:
    ensure_initialized()
    return get_stats(DB_PATH)


@router.post("/api/metro/sync-official")
def metro_sync_official() -> Dict[str, Any]:
    global _initialized
    try:
        payload = sync_official(OFFICIAL_PATH)
        result = load_official(payload, DB_PATH)
        _initialized = True
        return {"ok": True, "result": result, "stats": get_stats(DB_PATH)}
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail="同步官方地铁页面失败：{}".format(exc),
        ) from exc


@router.get("/api/metro/collector/queue")
def metro_queue(
    limit: int = Query(20, ge=1, le=100),
    retry: bool = False,
) -> Dict[str, Any]:
    ensure_initialized()
    return {"items": get_queue(limit, retry, DB_PATH), "stats": get_stats(DB_PATH)}


@router.post("/api/metro/collector/result")
def metro_result(payload: MetroCollectorResult) -> Dict[str, Any]:
    ensure_initialized()
    try:
        result = store_query_result(
            route_id=payload.route_id,
            status=payload.status,
            info=payload.info,
            candidates=payload.candidates,
            error=payload.error,
            db_path=DB_PATH,
        )
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "result": result, "stats": get_stats(DB_PATH)}


@router.get("/api/metro/collector/review")
def metro_review(limit: int = Query(100, ge=1, le=300)) -> Dict[str, Any]:
    ensure_initialized()
    return {"items": get_review_list(limit, DB_PATH)}


@router.get("/api/metro/collector/item/{route_id}")
def metro_item(route_id: str) -> Dict[str, Any]:
    ensure_initialized()
    try:
        return get_route_item(route_id, DB_PATH)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/api/metro/collector/choose")
def metro_choose(payload: MetroChooseRequest) -> Dict[str, Any]:
    ensure_initialized()
    try:
        result = choose_candidate(
            payload.route_id,
            payload.candidate_id,
            payload.reversed,
            DB_PATH,
        )
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "result": result, "stats": get_stats(DB_PATH)}


@router.post("/api/metro/collector/reset")
def metro_reset(payload: MetroResetRequest) -> Dict[str, Any]:
    ensure_initialized()
    allowed = {"matched", "review", "failed", "no_data", "error", "pending"}
    statuses = [item for item in payload.statuses if item in allowed]
    if not statuses:
        raise HTTPException(status_code=400, detail="没有有效状态")
    count = reset_routes(statuses, DB_PATH)
    return {"ok": True, "reset": count, "stats": get_stats(DB_PATH)}


@router.post("/api/metro/build")
def metro_build() -> Dict[str, Any]:
    ensure_initialized()
    try:
        result = build_metro_network(DB_PATH, NETWORK_PATH)
        network_cache.clear()
        return {
            "ok": True,
            "result": result,
            "view_url": "/metro",
            "learn_url": "/metro/learn",
        }
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Network data APIs
# ---------------------------------------------------------------------------


def require_network() -> Dict[str, Any]:
    try:
        return network_cache.get()
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail=(
                "尚未生成地铁线网。请先在 /metro/collector 完成采集和候选复核，"
                "再点击“构建地铁线网”。"
            ),
        ) from exc


def intersects(bbox: List[float], view: Tuple[float, float, float, float]) -> bool:
    minx, miny, maxx, maxy = bbox
    vx1, vy1, vx2, vy2 = view
    return maxx >= vx1 and minx <= vx2 and maxy >= vy1 and miny <= vy2


@router.get("/api/metro/network/overview")
def metro_overview() -> Dict[str, Any]:
    network = require_network()
    return {
        "version": network.get("version"),
        "network_id": network.get("network_id"),
        "name": network.get("name"),
        "built_at": network.get("built_at"),
        "world": network.get("world"),
        "stats": network.get("stats"),
        "routes": [
            {
                "id": route["id"],
                "official_id": route["official_id"],
                "route_no": route["route_no"],
                "short_name": route.get("short_name"),
                "color": route.get("color"),
                "direction": route["direction"],
                "direction_label": route["direction_label"],
                "operator": route.get("operator", "深圳地铁"),
                "start_stop": route["start_stop"],
                "end_stop": route["end_stop"],
                "score": route["score"],
                "match_state": route.get("match_state", "matched"),
                "bbox": route["bbox"],
                "path": route["paths"]["overview"],
                "stop_count": len(route.get("stops", [])),
            }
            for route in network.get("routes", [])
        ],
    }


@router.get("/api/metro/network/view")
def metro_view(
    minx: float,
    miny: float,
    maxx: float,
    maxy: float,
    zoom: float = Query(1.0, ge=0.1, le=100),
) -> Dict[str, Any]:
    network = require_network()
    view = (
        min(minx, maxx),
        min(miny, maxy),
        max(minx, maxx),
        max(miny, maxy),
    )
    level = "overview" if zoom < 2.2 else "medium" if zoom < 6 else "detail"
    routes: List[Dict[str, Any]] = []
    for route in network.get("routes", []):
        if intersects(route["bbox"], view):
            routes.append(
                {
                    "id": route["id"],
                    "route_no": route["route_no"],
                    "color": route.get("color"),
                    "direction": route["direction"],
                    "bbox": route["bbox"],
                    "path": route["paths"][level],
                    "score": route["score"],
                    "match_state": route.get("match_state", "matched"),
                }
            )

    stations: List[Dict[str, Any]] = []
    if zoom >= 2.0:
        stations = [
            station
            for station in network.get("stations", [])
            if view[0] <= station["x"] <= view[2]
            and view[1] <= station["y"] <= view[3]
        ]
    return {"level": level, "routes": routes, "stations": stations}


@router.get("/api/metro/network/route/{route_id}")
def metro_route(route_id: str) -> Dict[str, Any]:
    require_network()
    route = network_cache.route_map.get(route_id)
    if route is None:
        raise HTTPException(status_code=404, detail="地铁线路不存在")
    return route


# ---------------------------------------------------------------------------
# Schematic studio（示意几何校核工作台）
# ---------------------------------------------------------------------------


def _schematic_view(network: Dict[str, Any]) -> Dict[str, Any]:
    """构造示意工作台所需视图：每条 forward 线的真实几何/站点/示意 + 全网锚点。

    若线网尚未烘焙示意字段，则在内存里即时生成（不落盘），保证工作台开箱可用。
    """
    if "transfer_anchors" not in network:
        from .schematic import build_schematic_network
        network = {**network, "routes": [dict(r) for r in network.get("routes", [])]}
        build_schematic_network(network)

    layout = {}
    if LAYOUT_PATH.exists():
        try:
            with open(LAYOUT_PATH, "r", encoding="utf-8") as handle:
                layout = json.load(handle)
        except (OSError, ValueError):
            layout = {}

    layout_lines = layout.get("lines", {})
    layout_anchors = layout.get("anchors", {})

    routes_out: List[Dict[str, Any]] = []
    for route in network.get("routes", []):
        if route.get("direction") != "forward":
            continue
        schematic = route.get("schematic") or {}
        override = layout_lines.get(route["id"])
        if override:
            schematic = {
                **schematic,
                "path": override.get("path", schematic.get("path")),
                "station_progress": override.get("station_progress", schematic.get("station_progress")),
            }
        stops_out = [
            {
                "name": stop.get("name"),
                "progress": stop.get("progress"),
                "x": stop.get("x"),
                "y": stop.get("y"),
                "estimated": stop.get("estimated", False),
            }
            for stop in route.get("stops", [])
        ]
        routes_out.append({
            "id": route["id"],
            "route_no": route["route_no"],
            "short_name": route.get("short_name"),
            "color": route.get("color"),
            "direction_label": route.get("direction_label"),
            "start_stop": route.get("start_stop"),
            "end_stop": route.get("end_stop"),
            "real_path": route.get("paths", {}).get("medium") or route.get("paths", {}).get("detail", []),
            "stops": stops_out,
            "schematic": schematic,
        })

    anchors_out = {}
    for key, anchor in (network.get("transfer_anchors") or {}).items():
        override = layout_anchors.get(key)
        anchors_out[key] = {
            "name": anchor.get("name"),
            "x": override["x"] if override else anchor.get("x"),
            "y": override["y"] if override else anchor.get("y"),
            "lines": anchor.get("lines", []),
        }

    return {
        "world": network.get("world"),
        "alpha": layout.get("alpha", network.get("schematic_alpha", 0.55)),
        "transfer_anchors": anchors_out,
        "routes": routes_out,
        "has_layout": bool(layout),
    }


@router.get("/api/metro/schematic")
def metro_schematic() -> Dict[str, Any]:
    network = require_network()
    return _schematic_view(network)


@router.post("/api/metro/schematic/save")
def metro_schematic_save(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    data = {
        "alpha": payload.get("alpha"),
        "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "lines": payload.get("lines", {}),
        "anchors": payload.get("anchors", {}),
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LAYOUT_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(LAYOUT_PATH)
    return {"ok": True, "path": str(LAYOUT_PATH), "lines": len(data["lines"]), "anchors": len(data["anchors"])}


def _station_cluster_index(network: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    index: Dict[str, List[Dict[str, Any]]] = {}
    for station in network.get("stations", []):
        key = normalize_name(str(station.get("name", "")))
        index.setdefault(key, []).append(station)
    return index


def _nearest_station_cluster(
    stop: Dict[str, Any],
    index: Dict[str, List[Dict[str, Any]]],
) -> Optional[Dict[str, Any]]:
    key = normalize_name(str(stop.get("name", "")))
    candidates = index.get(key, [])
    if not candidates:
        return None
    x = float(stop.get("x", 0.0))
    y = float(stop.get("y", 0.0))
    return min(
        candidates,
        key=lambda item: (float(item.get("x", 0.0)) - x) ** 2
        + (float(item.get("y", 0.0)) - y) ** 2,
    )


def _learn_route_payload(route_id: str) -> Dict[str, Any]:
    network = require_network()
    route = network_cache.route_map.get(route_id)
    if route is None:
        raise HTTPException(status_code=404, detail="地铁线路不存在")

    cluster_index = _station_cluster_index(network)
    stops: List[Dict[str, Any]] = []
    for stop in route.get("stops", []):
        language = language_store.get(str(stop.get("name", "")))
        cluster = _nearest_station_cluster(stop, cluster_index)
        line_count = len(cluster.get("route_nos", [])) if cluster else 1
        stops.append(
            {
                **stop,
                "pinyin": language["pinyin"],
                "pinyin_source": language["pinyin_source"],
                "jyutping": language["jyutping"],
                "audioUrl": language["audio_url"],
                "reviewNote": language["note"],
                "lineCount": max(1, line_count),
                "transfer": line_count > 1,
                "majorTransfer": line_count >= 5,
                "cluster_id": cluster.get("id") if cluster else None,
                "route_nos": (
                    cluster.get("route_nos", [])
                    if cluster
                    else [route.get("route_no")]
                ),
            }
        )

    siblings = [
        {
            "id": item["id"],
            "direction": item.get("direction", ""),
            "direction_label": item.get("direction_label", ""),
            "start_stop": item.get("start_stop", ""),
            "end_stop": item.get("end_stop", ""),
        }
        for item in network.get("routes", [])
        if item.get("official_id") == route.get("official_id")
    ]

    return {
        "id": route["id"],
        "official_id": route.get("official_id"),
        "route_no": route.get("route_no", ""),
        "short_name": route.get("short_name", ""),
        "color": route.get("color", "#5cc8ff"),
        "name": "{} · {}".format(
            route.get("route_no", ""),
            route.get("direction_label", route.get("direction", "")),
        ),
        "direction": route.get("direction", ""),
        "direction_label": route.get("direction_label", ""),
        "operator": route.get("operator", "深圳地铁"),
        "start_stop": route.get("start_stop", ""),
        "end_stop": route.get("end_stop", ""),
        "score": route.get("score"),
        "match_state": route.get("match_state", "matched"),
        "bbox": route.get("bbox", []),
        "path": route.get("paths", {}).get("detail", []),
        "path_medium": route.get("paths", {}).get("medium", []),
        "geometry": route.get("geometry", {}),
        "stops": stops,
        "siblings": siblings,
        "built_at": network.get("built_at"),
        "world": network.get("world"),
        "network_id": "sz-metro",
        "network_type": "metro",
    }


@router.get("/api/metro/learn/route/{route_id}")
def metro_learn_route(route_id: str) -> Dict[str, Any]:
    return _learn_route_payload(route_id)


@router.post("/api/metro/learn/language")
def metro_update_language(payload: MetroLanguageRequest) -> Dict[str, Any]:
    try:
        result = language_store.update(
            name=payload.name,
            pinyin=payload.pinyin,
            jyutping=payload.jyutping,
            audio_url=payload.audio_url,
            note=payload.note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "item": result}


@router.get("/api/metro/learn/language/export")
def metro_export_language() -> JSONResponse:
    return JSONResponse(
        language_store.export(),
        headers={"Content-Disposition": 'attachment; filename="station_language.json"'},
    )


@router.get("/api/metro/search")
def metro_search(
    q: str = Query("", min_length=1, max_length=80),
    limit: int = Query(30, ge=1, le=100),
) -> Dict[str, Any]:
    network = require_network()
    query = q.strip().casefold()
    results: List[Dict[str, Any]] = []
    seen_routes: Set[str] = set()

    for route in network.get("routes", []):
        haystack = " ".join(
            [
                str(route.get("route_no", "")),
                str(route.get("short_name", "")),
                str(route.get("start_stop", "")),
                str(route.get("end_stop", "")),
            ]
        ).casefold()
        if query in haystack and route["id"] not in seen_routes:
            results.append(
                {
                    "type": "route",
                    "id": route["id"],
                    "title": "{} · {}".format(
                        route["route_no"], route["direction_label"]
                    ),
                    "subtitle": "{} → {}".format(
                        route["start_stop"], route["end_stop"]
                    ),
                    "bbox": route["bbox"],
                }
            )
            seen_routes.add(route["id"])
            if len(results) >= limit:
                break

    if len(results) < limit:
        for station in network.get("stations", []):
            if query in str(station.get("name", "")).casefold():
                results.append(
                    {
                        "type": "station",
                        "id": station["id"],
                        "title": station["name"],
                        "subtitle": "经过 {} 条方向线路".format(
                            station["route_count"]
                        ),
                        "x": station["x"],
                        "y": station["y"],
                        "route_ids": station["route_ids"],
                    }
                )
                if len(results) >= limit:
                    break
    return {"results": results}
