"""Bus authoring pages and collector/build APIs."""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ...common.network import create_network_router
from ...settings import WEB_DIR
from .builder import build
from .config import CATALOG_PATH, DB_PATH, NETWORK_PATH
from .db import (
    choose_candidate,
    get_queue,
    get_review_list,
    get_route_item,
    get_stats,
    load_catalog,
    reset_routes,
    store_query_result,
)
from .service import service


router = APIRouter(tags=["深圳公交"])


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


def initialize() -> Dict[str, Any]:
    if not CATALOG_PATH.is_file():
        raise RuntimeError("公交目录不存在：{}".format(CATALOG_PATH))
    return load_catalog(CATALOG_PATH, DB_PATH)


@router.get("/bus")
def network_page() -> FileResponse:
    return FileResponse(WEB_DIR / "pages" / "network.html")


@router.get("/bus/collector")
def collector_page() -> FileResponse:
    return FileResponse(WEB_DIR / "pages" / "collector.html")


@router.get("/bus/learn")
def learn_page() -> FileResponse:
    return FileResponse(WEB_DIR / "pages" / "learn.html", headers={"Cache-Control": "no-store"})


@router.get("/api/bus/config")
def config() -> Dict[str, Any]:
    key = os.getenv("AMAP_JS_KEY", "").strip()
    security = os.getenv("AMAP_SECURITY_CODE", "").strip()
    return {
        "network": "bus",
        "amap_js_key": key,
        "amap_security_code": security,
        "ready": bool(key and security),
        "city": os.getenv("AMAP_CITY", "深圳"),
        "default_delay_ms": int(os.getenv("COLLECT_DELAY_MS", "1200")),
    }


@router.get("/api/bus/status")
def status() -> Dict[str, Any]:
    return get_stats(DB_PATH)


@router.get("/api/bus/collector/queue")
def queue(limit: int = Query(20, ge=1, le=200), retry: bool = False) -> Dict[str, Any]:
    return {"items": get_queue(limit, retry, DB_PATH), "stats": get_stats(DB_PATH)}


@router.post("/api/bus/collector/results")
def save_result(payload: CollectorResult) -> Dict[str, Any]:
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


@router.get("/api/bus/collector/review")
def review(limit: int = Query(100, ge=1, le=500)) -> Dict[str, Any]:
    return {"items": get_review_list(limit, DB_PATH)}


@router.get("/api/bus/collector/items/{route_id}")
def item(route_id: int) -> Dict[str, Any]:
    try:
        return get_route_item(route_id, DB_PATH)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/api/bus/collector/selection")
def choose(payload: ChooseRequest) -> Dict[str, Any]:
    try:
        result = choose_candidate(payload.route_id, payload.direction, payload.candidate_index, DB_PATH)
    except (KeyError, IndexError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "result": result, "stats": get_stats(DB_PATH)}


@router.post("/api/bus/collector/reset")
def reset(payload: ResetRequest) -> Dict[str, Any]:
    allowed = {"matched", "review", "failed", "no_data", "error", "pending"}
    statuses = [value for value in payload.statuses if value in allowed]
    if not statuses:
        raise HTTPException(status_code=400, detail="没有有效状态")
    count = reset_routes(statuses, DB_PATH)
    return {"ok": True, "reset": count, "stats": get_stats(DB_PATH)}


@router.post("/api/bus/build")
def build_network(matched_only: bool = False) -> Dict[str, Any]:
    try:
        result = build(DB_PATH, NETWORK_PATH, include_review=not matched_only)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    service.cache.clear()
    return {"ok": True, "result": result, "view_url": "/bus", "learn_url": "/bus/learn"}


router.include_router(create_network_router(service))
