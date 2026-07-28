from __future__ import annotations

import gzip
import json
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from build_network import build as build_network
from db import (
    CATALOG_PATH,
    DATA_DIR,
    DB_PATH,
    choose_candidate,
    get_queue,
    get_review_list,
    get_route_item,
    get_stats,
    load_catalog,
    normalize_stop,
    reset_routes,
    store_query_result,
)
from language_data import StationLanguageStore
from metro.router import router as metro_router

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
STATIC_DIR = ROOT / "static"
NETWORK_PATH = DATA_DIR / "network.json.gz"
LANGUAGE_PATH = DATA_DIR / "station_language.json"


class CollectorResult(BaseModel):
    route_id: int
    status: str
    info: str = ""
    candidates: List[Dict[str, Any]] = Field(default_factory=list)
    error: Optional[str] = None


class ChooseRequest(BaseModel):
    route_id: int
    direction: str
    candidate_index: int


class ResetRequest(BaseModel):
    statuses: List[str]


class StationLanguageRequest(BaseModel):
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
        self.lock = threading.Lock()
        self.route_map: Dict[str, Dict[str, Any]] = {}

    def get(self) -> Dict[str, Any]:
        if not self.path.exists():
            raise FileNotFoundError(self.path)
        mtime = self.path.stat().st_mtime
        if self.data is None or mtime != self.mtime:
            with self.lock:
                mtime = self.path.stat().st_mtime
                if self.data is None or mtime != self.mtime:
                    with gzip.open(self.path, "rt", encoding="utf-8") as handle:
                        self.data = json.load(handle)
                    self.mtime = mtime
                    self.route_map = {
                        str(item["id"]): item for item in self.data.get("routes", [])
                    }
        return self.data

    def clear(self) -> None:
        with self.lock:
            self.data = None
            self.route_map = {}
            self.mtime = -1.0


network_cache = NetworkCache(NETWORK_PATH)
language_store = StationLanguageStore(LANGUAGE_PATH)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if CATALOG_PATH.exists():
        load_catalog(CATALOG_PATH, DB_PATH)
    yield


app = FastAPI(
    title="深圳公交全网采集、可视化与站名学习",
    version="2.0.0",
    lifespan=lifespan,
)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(metro_router)


@app.get("/")
def root_redirect() -> RedirectResponse:
    return RedirectResponse(url="/bus", status_code=307)


@app.get("/bus")
def bus_home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/bus/collector")
def bus_collector() -> FileResponse:
    return FileResponse(STATIC_DIR / "collector.html")


@app.get("/bus/learn")
def bus_learn() -> FileResponse:
    return FileResponse(STATIC_DIR / "learn.html")


# 旧入口保留为兼容跳转，避免已有书签和页面链接失效。
@app.get("/collector")
def collector_legacy() -> RedirectResponse:
    return RedirectResponse(url="/bus/collector", status_code=307)


@app.get("/learn")
def learn_legacy(request: Request) -> RedirectResponse:
    network = request.query_params.get("network", "bus")
    target = "/metro/learn" if network == "metro" else "/bus/learn"
    route_id = request.query_params.get("route")
    if route_id:
        from urllib.parse import quote
        target = "%s?route=%s" % (target, quote(route_id, safe=""))
    return RedirectResponse(url=target, status_code=307)


@app.get("/schematic")
def schematic_alias() -> RedirectResponse:
    return RedirectResponse(url="/bus/learn", status_code=307)


@app.get("/api/config")
def config() -> Dict[str, Any]:
    key = os.getenv("AMAP_JS_KEY", "").strip()
    security = os.getenv("AMAP_SECURITY_CODE", "").strip()
    return {
        "amap_js_key": key,
        "amap_security_code": security,
        "ready": bool(key and security),
        "city": os.getenv("AMAP_CITY", "深圳"),
        "default_delay_ms": int(os.getenv("COLLECT_DELAY_MS", "1200")),
    }


@app.get("/api/public/config")
def public_config(request: Request) -> Dict[str, Any]:
    """Return only the browser-safe map runtime settings.

    The Web JS key is an identifier and may be delivered to the browser.  The
    security code is restricted to the loopback-only internal application;
    public deployments use AMap's proxy service host instead.
    """

    client_host = request.client.host if request.client else ""
    payload: Dict[str, Any] = {
        "amap_js_key": os.getenv("AMAP_JS_KEY", "").strip(),
        "amap_service_host": os.getenv("AMAP_SERVICE_HOST", "/_AMapService").strip(),
        "map_ready": bool(os.getenv("AMAP_JS_KEY", "").strip()),
        "admin_enabled": True,
    }
    if client_host in {"127.0.0.1", "::1", "localhost", "testclient"}:
        payload["amap_security_code"] = os.getenv("AMAP_SECURITY_CODE", "").strip()
    return payload


@app.get("/api/status")
def status() -> Dict[str, Any]:
    return get_stats(DB_PATH)


@app.get("/api/collector/queue")
def collector_queue(
    limit: int = Query(20, ge=1, le=200),
    retry: bool = False,
) -> Dict[str, Any]:
    return {"items": get_queue(limit, retry, DB_PATH), "stats": get_stats(DB_PATH)}


@app.post("/api/collector/result")
def collector_result(payload: CollectorResult) -> Dict[str, Any]:
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


@app.get("/api/collector/review")
def collector_review(limit: int = Query(100, ge=1, le=500)) -> Dict[str, Any]:
    return {"items": get_review_list(limit, DB_PATH)}


@app.get("/api/collector/item/{route_id}")
def collector_item(route_id: int) -> Dict[str, Any]:
    try:
        return get_route_item(route_id, DB_PATH)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/collector/choose")
def collector_choose(payload: ChooseRequest) -> Dict[str, Any]:
    try:
        result = choose_candidate(
            payload.route_id, payload.direction, payload.candidate_index, DB_PATH
        )
    except (KeyError, IndexError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "result": result, "stats": get_stats(DB_PATH)}


@app.post("/api/collector/reset")
def collector_reset(payload: ResetRequest) -> Dict[str, Any]:
    allowed = {"matched", "review", "failed", "no_data", "error", "pending"}
    statuses = [item for item in payload.statuses if item in allowed]
    if not statuses:
        raise HTTPException(status_code=400, detail="没有有效状态")
    count = reset_routes(statuses, DB_PATH)
    return {"ok": True, "reset": count, "stats": get_stats(DB_PATH)}


@app.post("/api/build")
def build_endpoint(matched_only: bool = False) -> Dict[str, Any]:
    try:
        result = build_network(DB_PATH, NETWORK_PATH, include_review=not matched_only)
        network_cache.clear()
        return {"ok": True, "result": result}
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _require_network() -> Dict[str, Any]:
    try:
        return network_cache.get()
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail="尚未生成全网数据。请先在 /bus/collector 采集线路，然后执行“构建全网”。",
        ) from exc


@app.get("/api/network/overview")
def network_overview() -> Dict[str, Any]:
    network = _require_network()
    return {
        "version": network.get("version"),
        "built_at": network.get("built_at"),
        "world": network.get("world"),
        "stats": network.get("stats"),
        "routes": [
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
        ],
    }


def intersects(bbox: List[float], view: Tuple[float, float, float, float]) -> bool:
    minx, miny, maxx, maxy = bbox
    vx1, vy1, vx2, vy2 = view
    return maxx >= vx1 and minx <= vx2 and maxy >= vy1 and miny <= vy2


@app.get("/api/network/view")
def network_view(
    minx: float,
    miny: float,
    maxx: float,
    maxy: float,
    zoom: float = Query(1.0, ge=0.1, le=100),
) -> Dict[str, Any]:
    network = _require_network()
    view = (min(minx, maxx), min(miny, maxy), max(minx, maxx), max(miny, maxy))
    level = "overview" if zoom < 2.2 else "medium" if zoom < 6 else "detail"
    routes: List[Dict[str, Any]] = []
    for route in network.get("routes", []):
        if intersects(route["bbox"], view):
            routes.append(
                {
                    "id": route["id"],
                    "route_no": route["route_no"],
                    "direction": route["direction"],
                    "bbox": route["bbox"],
                    "path": route["paths"][level],
                    "score": route["score"],
                    "match_state": route["match_state"],
                }
            )
    stations: List[Dict[str, Any]] = []
    if zoom >= 2.6:
        stations = [
            station
            for station in network.get("stations", [])
            if view[0] <= station["x"] <= view[2]
            and view[1] <= station["y"] <= view[3]
        ]
        if len(stations) > 8000:
            stations.sort(
                key=lambda item: (item["route_count"], item["samples"]), reverse=True
            )
            stations = stations[:8000]
    return {"level": level, "routes": routes, "stations": stations}


@app.get("/api/network/route/{route_id}")
def network_route(route_id: str) -> Dict[str, Any]:
    _require_network()
    route = network_cache.route_map.get(route_id)
    if route is None:
        raise HTTPException(status_code=404, detail="线路不存在")
    return route


def _station_cluster_index(network: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    index: Dict[str, List[Dict[str, Any]]] = {}
    for station in network.get("stations", []):
        key = normalize_stop(str(station.get("name", "")))
        index.setdefault(key, []).append(station)
    return index


def _nearest_station_cluster(
    stop: Dict[str, Any], index: Dict[str, List[Dict[str, Any]]]
) -> Optional[Dict[str, Any]]:
    key = normalize_stop(str(stop.get("name", "")))
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


def _route_payload(route_id: str) -> Dict[str, Any]:
    network = _require_network()
    route = network_cache.route_map.get(route_id)
    if route is None:
        raise HTTPException(status_code=404, detail="线路不存在")

    cluster_index = _station_cluster_index(network)
    stops: List[Dict[str, Any]] = []
    for stop in route.get("stops", []):
        language = language_store.get(str(stop.get("name", "")))
        cluster = _nearest_station_cluster(stop, cluster_index)
        route_count = int(cluster.get("route_count", 1)) if cluster else 1
        stops.append(
            {
                **stop,
                "pinyin": language["pinyin"],
                "pinyin_source": language["pinyin_source"],
                "jyutping": language["jyutping"],
                "audioUrl": language["audio_url"],
                "reviewNote": language["note"],
                "lineCount": route_count,
                "transfer": route_count > 1,
                "majorTransfer": route_count >= 5,
                "cluster_id": cluster.get("id") if cluster else None,
                "route_nos": (
                    cluster.get("route_nos", []) if cluster else [route.get("route_no")]
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
        "name": "%s · %s"
        % (route.get("route_no", ""), route.get("direction_label", route.get("direction", ""))),
        "direction": route.get("direction", ""),
        "direction_label": route.get("direction_label", ""),
        "operator": route.get("operator", ""),
        "start_stop": route.get("start_stop", ""),
        "end_stop": route.get("end_stop", ""),
        "score": route.get("score"),
        "match_state": route.get("match_state"),
        "bbox": route.get("bbox", []),
        "path": route.get("paths", {}).get("detail", []),
        "path_medium": route.get("paths", {}).get("medium", []),
        "geometry": route.get("geometry", {}),
        "stops": stops,
        "siblings": siblings,
        "built_at": network.get("built_at"),
        "world": network.get("world"),
    }


@app.get("/api/learn/route/{route_id}")
def learn_route(route_id: str) -> Dict[str, Any]:
    return _route_payload(route_id)


@app.get("/api/schematic/route/{route_id}")
def schematic_route_compat(route_id: str) -> Dict[str, Any]:
    return _route_payload(route_id)


def _update_language(payload: StationLanguageRequest) -> Dict[str, Any]:
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


@app.post("/api/learn/language")
def update_learn_language(payload: StationLanguageRequest) -> Dict[str, Any]:
    return _update_language(payload)


@app.post("/api/schematic/language")
def update_schematic_language_compat(payload: StationLanguageRequest) -> Dict[str, Any]:
    return _update_language(payload)


@app.get("/api/learn/language/export")
def export_learn_language() -> JSONResponse:
    return JSONResponse(
        language_store.export(),
        headers={"Content-Disposition": 'attachment; filename="station_language.json"'},
    )


@app.get("/api/schematic/language/export")
def export_schematic_language_compat() -> JSONResponse:
    return export_learn_language()


@app.get("/api/search")
def search(
    q: str = Query("", min_length=1, max_length=80),
    limit: int = Query(30, ge=1, le=100),
) -> Dict[str, Any]:
    network = _require_network()
    query = q.strip().casefold()
    results: List[Dict[str, Any]] = []
    seen_routes: Set[str] = set()
    for route in network.get("routes", []):
        haystack = " ".join(
            [
                str(route.get("route_no", "")),
                str(route.get("start_stop", "")),
                str(route.get("end_stop", "")),
                str(route.get("operator", "")),
            ]
        ).casefold()
        if query in haystack and route["id"] not in seen_routes:
            results.append(
                {
                    "type": "route",
                    "id": route["id"],
                    "title": "%s · %s"
                    % (route["route_no"], route["direction_label"]),
                    "subtitle": "%s → %s"
                    % (route["start_stop"], route["end_stop"]),
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
                        "subtitle": "%s 条方向线路" % station["route_count"],
                        "x": station["x"],
                        "y": station["y"],
                        "route_ids": station["route_ids"],
                    }
                )
                if len(results) >= limit:
                    break
    return {"results": results}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=False)
