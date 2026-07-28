"""Read-only public edition backed exclusively by audited derivative assets."""

from __future__ import annotations

import hmac
import json
import mimetypes
import os
import re
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Deque, Dict

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from ..settings import PUBLIC_DIR, learn_experience_config


ACCESS_TOKEN = os.getenv("TRANSIT_PUBLIC_ACCESS_TOKEN", "").strip()
TRUST_PROXY = os.getenv("TRANSIT_TRUST_PROXY", "false").lower() in {"1", "true", "yes"}
LINE_LIMIT = max(1, int(os.getenv("TRANSIT_PUBLIC_LINES_PER_MINUTE", "30")))
AMAP_JS_KEY = os.getenv("AMAP_JS_KEY", "").strip()
AMAP_SERVICE_HOST = os.getenv("AMAP_SERVICE_HOST", "").strip()
_SAFE_ID = re.compile(r"^[0-9A-Za-z._-]+$")
_NETWORKS = {"bus", "metro"}

app = FastAPI(
    title="Transit Explorer Public Derivative Service",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

_cache_lock = threading.Lock()
_json_cache: Dict[str, Dict[str, Any]] = {}
_rate_lock = threading.Lock()
_line_requests: Dict[str, Deque[float]] = defaultdict(deque)


def _bundle_json(relative_path: str) -> Dict[str, Any]:
    path = PUBLIC_DIR / relative_path
    if not path.is_file():
        raise HTTPException(status_code=503, detail="公开派生资产尚未构建")
    cache_key = str(path)
    mtime = path.stat().st_mtime_ns
    cached = _json_cache.get(cache_key)
    if cached is None or cached.get("mtime") != mtime:
        with _cache_lock:
            cached = _json_cache.get(cache_key)
            if cached is None or cached.get("mtime") != mtime:
                cached = {"mtime": mtime, "payload": json.loads(path.read_text(encoding="utf-8"))}
                _json_cache[cache_key] = cached
    return cached["payload"]


def _require_network(network_id: str) -> str:
    if network_id not in _NETWORKS or not (PUBLIC_DIR / "networks" / network_id / "manifest.json").is_file():
        raise HTTPException(status_code=404, detail="交通网络不存在")
    return network_id


def _network_json(network_id: str, filename: str) -> Dict[str, Any]:
    network_id = _require_network(network_id)
    return _bundle_json("networks/{}/{}".format(network_id, filename))


def _line_path(network_id: str, line_id: str, filename: str) -> Path:
    network_id = _require_network(network_id)
    if not _SAFE_ID.fullmatch(line_id):
        raise HTTPException(status_code=404, detail="线路不存在")
    path = PUBLIC_DIR / "networks" / network_id / "lines" / line_id / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="线路资产不存在")
    return path


def _client_key(request: Request) -> str:
    if TRUST_PROXY:
        forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
        if forwarded:
            return forwarded
    return request.client.host if request.client else "unknown"


def _require_access(request: Request) -> None:
    if not ACCESS_TOKEN:
        return
    authorization = request.headers.get("authorization", "")
    supplied = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if not supplied or not hmac.compare_digest(supplied, ACCESS_TOKEN):
        raise HTTPException(status_code=401, detail="需要有效访问口令", headers={"WWW-Authenticate": "Bearer"})


def _rate_limit_line(request: Request) -> None:
    key = _client_key(request)
    now = time.monotonic()
    with _rate_lock:
        queue = _line_requests[key]
        while queue and now - queue[0] >= 60:
            queue.popleft()
        if len(queue) >= LINE_LIMIT:
            raise HTTPException(status_code=429, detail="线路读取过于频繁，请稍后再试", headers={"Retry-After": "60"})
        queue.append(now)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "private, no-store, max-age=0"
    return response


@app.get("/", include_in_schema=False)
@app.get("/bus", include_in_schema=False)
@app.get("/metro", include_in_schema=False)
def public_index() -> FileResponse:
    path = PUBLIC_DIR / "index.html"
    if not path.is_file():
        raise HTTPException(status_code=503, detail="请先运行 transit-explorer publish public")
    return FileResponse(path, headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/assets/{asset_path:path}", include_in_schema=False)
def public_asset(asset_path: str) -> FileResponse:
    root = (PUBLIC_DIR / "assets").resolve()
    path = (root / asset_path).resolve()
    if root not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="资源不存在")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/networks")
def public_networks() -> JSONResponse:
    return JSONResponse(_bundle_json("networks.json"))


@app.get("/api/{network_id}/runtime")
def public_runtime(network_id: str) -> JSONResponse:
    manifest = _network_json(network_id, "manifest.json")
    modes = {mode for line in manifest.get("lines", []) for mode in line.get("availableModes", [])}
    return JSONResponse(
        {
            "edition": "public",
            "network": network_id,
            "buildId": manifest.get("buildId"),
            "requiresAccess": bool(ACCESS_TOKEN),
            "capabilities": {
                "flatMap": "flat" in modes,
                "animatedMap": "animated" in modes,
                "realMap": "real" in modes,
                "practice": True,
                "broadcast": True,
                "editing": False,
                "vectorGeometry": False,
                "importExport": False,
            },
            "amap": {
                "jsKey": AMAP_JS_KEY,
                "serviceHost": AMAP_SERVICE_HOST,
                "ready": bool(AMAP_JS_KEY and AMAP_SERVICE_HOST),
            },
            "learnExperience": learn_experience_config(protected_geometry=True),
        }
    )


@app.get("/api/{network_id}/manifest", dependencies=[Depends(_require_access)])
def public_manifest(network_id: str) -> JSONResponse:
    manifest = dict(_network_json(network_id, "manifest.json"))
    manifest["requiresAccess"] = bool(ACCESS_TOKEN)
    return JSONResponse(manifest)


@app.get(
    "/api/{network_id}/lines/{line_id}/scene",
    dependencies=[Depends(_require_access), Depends(_rate_limit_line)],
)
def public_line_scene(network_id: str, line_id: str) -> FileResponse:
    return FileResponse(_line_path(network_id, line_id, "scene.json"), media_type="application/json")


@app.get(
    "/api/{network_id}/lines/{line_id}/geographic",
    dependencies=[Depends(_require_access), Depends(_rate_limit_line)],
)
def public_line_geographic(network_id: str, line_id: str) -> FileResponse:
    return FileResponse(_line_path(network_id, line_id, "geographic.json"), media_type="application/json")


@app.get("/api/{network_id}/search", dependencies=[Depends(_require_access)])
def public_station_search(network_id: str, q: str = "") -> JSONResponse:
    query = q.strip()[:40]
    if not query:
        return JSONResponse({"results": []})
    folded = query.casefold()
    compact = re.sub(r"[^0-9a-z]+", "", folded)
    matches = []
    for station in _network_json(network_id, "search-index.json").get("stations", []):
        name = str(station.get("name", ""))
        pinyin = str(station.get("pinyin", ""))
        pinyin_compact = re.sub(r"[^0-9a-z]+", "", pinyin.casefold())
        if folded in name.casefold() or (compact and compact in pinyin_compact):
            matches.append(station)
    matches.sort(
        key=lambda item: (
            0 if str(item.get("name", "")).casefold() == folded else 1,
            0 if str(item.get("name", "")).casefold().startswith(folded) else 1,
            len(str(item.get("name", ""))),
            str(item.get("name", "")),
        )
    )
    return JSONResponse({"results": matches[:8]})


@app.get("/health", include_in_schema=False)
def health() -> Dict[str, Any]:
    payload = _bundle_json("networks.json")
    return {
        "ok": True,
        "edition": "public",
        "buildId": payload.get("buildId"),
        "networks": [item.get("id") for item in payload.get("networks", [])],
        "sourceGeometryMounted": False,
    }
