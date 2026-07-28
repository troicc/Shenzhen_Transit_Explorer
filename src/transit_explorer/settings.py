"""Repository and runtime paths shared by every command and edition."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")


def _configured_path(name: str, default: Path) -> Path:
    raw = os.getenv(name, "").strip()
    return Path(raw).expanduser().resolve() if raw else default.resolve()


WEB_DIR = _configured_path("TRANSIT_WEB_DIR", PROJECT_ROOT / "web")
RESOURCES_DIR = _configured_path("TRANSIT_RESOURCES_DIR", PROJECT_ROOT / "resources")
VAR_DIR = _configured_path("TRANSIT_VAR_DIR", PROJECT_ROOT / "var")
DIST_DIR = _configured_path("TRANSIT_DIST_DIR", PROJECT_ROOT / "dist")
PUBLIC_DIR = _configured_path("TRANSIT_PUBLIC_DIR", DIST_DIR / "public")
SHARED_VAR_DIR = VAR_DIR / "shared"
LANGUAGE_PATH = SHARED_VAR_DIR / "language.json"


def browser_map_config(*, include_security_code: bool = False) -> dict:
    """Return the browser-visible AMap configuration for an application edition."""

    key = os.getenv("AMAP_JS_KEY", "").strip()
    service_host = os.getenv("AMAP_SERVICE_HOST", "").strip()
    payload = {
        "amap_js_key": key,
        "amap_service_host": service_host,
        "map_ready": bool(key and (service_host or include_security_code)),
    }
    if include_security_code:
        payload["amap_security_code"] = os.getenv("AMAP_SECURITY_CODE", "").strip()
    return payload
