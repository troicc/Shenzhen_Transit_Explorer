"""Metro authoring pages, collector APIs and schematic studio."""

from __future__ import annotations

import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ...common.network import create_network_router
from ...settings import WEB_DIR
from .builder import build
from .config import DB_PATH, NETWORK_PATH, OFFICIAL_PATH
from .db import (
    choose_candidate,
    get_queue,
    get_review_list,
    get_route_item,
    get_stats,
    initialize as initialize_database,
    load_official,
    reset_routes,
    store_query_result,
)
from .official import sync
from .presentation import presentation_repository
from .service import service


router = APIRouter(tags=["深圳地铁"])
_init_lock = threading.Lock()
_initialized = False


class CollectorResult(BaseModel):
    route_id: str
    status: str
    info: str = ""
    candidates: List[Dict[str, Any]] = Field(default_factory=list)
    error: Optional[str] = None


class ChooseRequest(BaseModel):
    route_id: str
    candidate_id: int
    reversed: Optional[bool] = None


class ResetRequest(BaseModel):
    statuses: List[str]


def initialize() -> Dict[str, Any]:
    global _initialized
    if _initialized:
        return get_stats(DB_PATH)
    with _init_lock:
        if not _initialized:
            result = initialize_database(DB_PATH)
            _initialized = True
            return result
    return get_stats(DB_PATH)


@router.get("/metro")
def network_page() -> FileResponse:
    return FileResponse(WEB_DIR / "pages" / "network.html")


@router.get("/metro/collector")
def collector_page() -> FileResponse:
    return FileResponse(WEB_DIR / "pages" / "collector.html")


@router.get("/metro/learn")
def learn_page() -> FileResponse:
    return FileResponse(WEB_DIR / "pages" / "learn.html", headers={"Cache-Control": "no-store"})


@router.get("/studio")
def studio_page() -> FileResponse:
    return FileResponse(WEB_DIR / "pages" / "studio.html")


@router.get("/api/metro/config")
def config() -> Dict[str, Any]:
    key = os.getenv("AMAP_JS_KEY", "").strip()
    security = os.getenv("AMAP_SECURITY_CODE", "").strip()
    return {
        "network": "metro",
        "amap_js_key": key,
        "amap_security_code": security,
        "ready": bool(key and security),
        "city": os.getenv("AMAP_CITY", "深圳"),
        "default_delay_ms": int(os.getenv("COLLECT_DELAY_MS", "1200")),
    }


@router.get("/api/metro/status")
def status() -> Dict[str, Any]:
    initialize()
    return get_stats(DB_PATH)


@router.post("/api/metro/catalog/sync")
def sync_catalog() -> Dict[str, Any]:
    global _initialized
    try:
        payload = sync(OFFICIAL_PATH)
        result = load_official(payload, DB_PATH)
        _initialized = True
    except Exception as exc:
        raise HTTPException(status_code=502, detail="同步官方地铁目录失败：{}".format(exc)) from exc
    return {"ok": True, "result": result, "stats": get_stats(DB_PATH)}


@router.get("/api/metro/collector/queue")
def queue(limit: int = Query(20, ge=1, le=100), retry: bool = False) -> Dict[str, Any]:
    initialize()
    return {"items": get_queue(limit, retry, DB_PATH), "stats": get_stats(DB_PATH)}


@router.post("/api/metro/collector/results")
def save_result(payload: CollectorResult) -> Dict[str, Any]:
    initialize()
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
def review(limit: int = Query(100, ge=1, le=300)) -> Dict[str, Any]:
    initialize()
    return {"items": get_review_list(limit, DB_PATH)}


@router.get("/api/metro/collector/items/{route_id}")
def item(route_id: str) -> Dict[str, Any]:
    initialize()
    try:
        return get_route_item(route_id, DB_PATH)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/api/metro/collector/selection")
def choose(payload: ChooseRequest) -> Dict[str, Any]:
    initialize()
    try:
        result = choose_candidate(payload.route_id, payload.candidate_id, payload.reversed, DB_PATH)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "result": result, "stats": get_stats(DB_PATH)}


@router.post("/api/metro/collector/reset")
def reset(payload: ResetRequest) -> Dict[str, Any]:
    initialize()
    allowed = {"matched", "review", "failed", "no_data", "error", "pending"}
    statuses = [value for value in payload.statuses if value in allowed]
    if not statuses:
        raise HTTPException(status_code=400, detail="没有有效状态")
    count = reset_routes(statuses, DB_PATH)
    return {"ok": True, "reset": count, "stats": get_stats(DB_PATH)}


@router.post("/api/metro/build")
def build_network() -> Dict[str, Any]:
    initialize()
    try:
        result = build(DB_PATH, NETWORK_PATH)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    service.cache.clear()
    service.invalidate_presentation()
    return {"ok": True, "result": result, "view_url": "/metro", "learn_url": "/metro/learn"}


def _schematic_view(network: Dict[str, Any]) -> Dict[str, Any]:
    presentation = presentation_repository.get_network(network)
    routes = []
    for route in presentation.get("routes", []):
        if route.get("direction") != "forward":
            continue
        schematic = route.get("schematic") or {}
        focus = (route.get("geometry") or {}).get("focus") or {}
        routes.append(
            {
                "id": route["id"],
                "layout_key": focus.get("logicalLineId") or route.get("short_name"),
                "route_no": route.get("route_no"),
                "short_name": route.get("short_name"),
                "color": route.get("color"),
                "direction_label": route.get("direction_label"),
                "start_stop": route.get("start_stop"),
                "end_stop": route.get("end_stop"),
                "real_path": route.get("paths", {}).get("medium") or route.get("paths", {}).get("detail", []),
                "stops": [
                    {
                        "name": stop.get("name"),
                        "progress": stop.get("progress"),
                        "x": stop.get("x"),
                        "y": stop.get("y"),
                        "estimated": stop.get("estimated", False),
                    }
                    for stop in route.get("stops", [])
                ],
                "schematic": schematic,
            }
        )
    anchors = {
        key: {
            "name": anchor.get("name"),
            "x": anchor.get("x"),
            "y": anchor.get("y"),
            "lines": anchor.get("lines", []),
        }
        for key, anchor in (presentation.get("transfer_anchors") or {}).items()
    }
    layout = presentation.get("presentation_layout") or {}
    return {
        "world": presentation.get("world"),
        "revision": presentation.get("presentation_revision"),
        "alpha": layout.get("alpha", presentation.get("schematic_alpha", 0.55)),
        "transfer_anchors": anchors,
        "routes": routes,
        "has_layout": bool(layout.get("applied")),
    }


@router.get("/api/metro/studio")
def studio_data() -> Dict[str, Any]:
    return _schematic_view(service.require_network())


@router.get("/api/metro/presentation")
def presentation_data() -> Dict[str, Any]:
    return service.presentation()


@router.get("/api/metro/presentation/revision")
def presentation_revision() -> Dict[str, Any]:
    return service.presentation_revision()


@router.post("/api/metro/studio")
def save_studio(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    network = service.require_network()
    try:
        data = presentation_repository.normalize_layout(payload, network)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    data["saved_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    presentation_repository.save_layout(data)
    service.invalidate_presentation()
    revision = presentation_repository.revision(network)
    return {
        "ok": True,
        "revision": revision,
        "lines": len(data["lines"]),
        "anchors": len(data["anchors"]),
        "learnUrl": "/metro/learn?layoutRevision={}".format(revision),
        "message": "已保存并应用到地铁练习",
    }


router.include_router(create_network_router(service))
