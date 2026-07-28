"""Read-only public service backed exclusively by derivative assets.

The public process never opens the precise source export or any review
artifact. A deployable bundle is therefore safe by construction as well as by
route filtering.
"""

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

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
DIST_DIR = Path(
    os.getenv("ZHANYUE_PUBLIC_BUNDLE_PATH", str(ROOT / "zhanyue" / "dist" / "public"))
).resolve()
ACCESS_TOKEN = os.getenv("ZHANYUE_PUBLIC_ACCESS_TOKEN", "").strip()
TRUST_PROXY = os.getenv("ZHANYUE_TRUST_PROXY", "false").lower() in {"1", "true", "yes"}
LINE_LIMIT = max(1, int(os.getenv("ZHANYUE_PUBLIC_LINES_PER_MINUTE", "30")))
AMAP_JS_KEY = os.getenv("AMAP_JS_KEY", "").strip()
AMAP_SERVICE_HOST = os.getenv("AMAP_SERVICE_HOST", "").strip()
_SAFE_ID = re.compile(r"^[0-9A-Za-z._-]+$")

app = FastAPI(
    title="Zhanyue Public Derivative Service",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

_cache_lock = threading.Lock()
_json_cache: Dict[str, Dict[str, Any]] = {}
_rate_lock = threading.Lock()
_line_requests: Dict[str, Deque[float]] = defaultdict(deque)


def _bundle_json(name: str) -> Dict[str, Any]:
    path = DIST_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=503, detail="公开衍生资产尚未构建")
    cache_key = str(path)
    mtime = path.stat().st_mtime_ns
    cached = _json_cache.get(cache_key)
    if cached is None or cached.get("mtime") != mtime:
        with _cache_lock:
            cached = _json_cache.get(cache_key)
            if cached is None or cached.get("mtime") != mtime:
                payload = json.loads(path.read_text(encoding="utf-8"))
                cached = {"mtime": mtime, "payload": payload}
                _json_cache[cache_key] = cached
    return cached["payload"]


def _line_path(line_id: str, filename: str) -> Path:
    if not _SAFE_ID.fullmatch(line_id):
        raise HTTPException(status_code=404, detail="线路不存在")
    path = DIST_DIR / "lines" / line_id / filename
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
            raise HTTPException(
                status_code=429,
                detail="线路读取过于频繁，请稍后再试",
                headers={"Retry-After": "60"},
            )
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
def public_index() -> FileResponse:
    path = DIST_DIR / "index.html"
    if not path.is_file():
        raise HTTPException(status_code=503, detail="请先运行 python -m zhanyue.build --mode public")
    return FileResponse(path, headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/assets/{asset_path:path}", include_in_schema=False)
def public_asset(asset_path: str) -> FileResponse:
    asset_root = (DIST_DIR / "assets").resolve()
    path = (asset_root / asset_path).resolve()
    if asset_root not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="资源不存在")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.get("/api/runtime")
def public_runtime() -> JSONResponse:
    manifest = _bundle_json("manifest.json")
    modes = {mode for line in manifest.get("lines", []) for mode in line.get("availableModes", [])}
    return JSONResponse(
        {
            "edition": "public",
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
        }
    )


@app.get("/api/manifest", dependencies=[Depends(_require_access)])
def public_manifest() -> JSONResponse:
    manifest = dict(_bundle_json("manifest.json"))
    manifest["requiresAccess"] = bool(ACCESS_TOKEN)
    return JSONResponse(manifest)


@app.get(
    "/api/lines/{line_id}/scene",
    dependencies=[Depends(_require_access), Depends(_rate_limit_line)],
)
def public_line_scene(line_id: str) -> FileResponse:
    return FileResponse(_line_path(line_id, "scene.json"), media_type="application/json")


@app.get(
    "/api/lines/{line_id}/geographic",
    dependencies=[Depends(_require_access), Depends(_rate_limit_line)],
)
def public_line_geographic(line_id: str) -> FileResponse:
    return FileResponse(_line_path(line_id, "geographic.json"), media_type="application/json")


@app.get("/api/search", dependencies=[Depends(_require_access)])
def public_station_search(q: str = "") -> JSONResponse:
    query = q.strip()[:40]
    if not query:
        return JSONResponse({"results": []})
    query_folded = query.casefold()
    query_compact = re.sub(r"[^0-9a-z]+", "", query_folded)
    matches = []
    for station in _bundle_json("search-index.json").get("stations", []):
        name = str(station.get("name", ""))
        pinyin = str(station.get("pinyin", ""))
        pinyin_compact = re.sub(r"[^0-9a-z]+", "", pinyin.casefold())
        if query_folded in name.casefold() or (query_compact and query_compact in pinyin_compact):
            matches.append(station)
    matches.sort(
        key=lambda item: (
            0 if str(item.get("name", "")).casefold() == query_folded else 1,
            0 if str(item.get("name", "")).casefold().startswith(query_folded) else 1,
            len(str(item.get("name", ""))),
            str(item.get("name", "")),
        )
    )
    return JSONResponse({"results": matches[:8]})


@app.get("/health", include_in_schema=False)
def health() -> Dict[str, Any]:
    manifest = _bundle_json("manifest.json")
    return {
        "ok": True,
        "edition": "public",
        "buildId": manifest.get("buildId"),
        "lines": len(manifest.get("lines", [])),
        "sourceGeometryMounted": False,
    }
