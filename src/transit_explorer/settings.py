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
LEARN_EXPERIENCE_PROFILES = ("standard", "metroFinal", "busExperimental")
LEARN_EXPERIENCE_PRESETS = {
    "metroFinal": {
        "schematicOverview": True,
        "coverFlip": True,
        "routeIsolation": True,
        "routeStretch": True,
        "cameraFollow": True,
        "arrivalPulse": True,
        "completionRebound": True,
    },
    "standard": {
        "schematicOverview": False,
        "coverFlip": False,
        "routeIsolation": True,
        "routeStretch": False,
        "cameraFollow": False,
        "arrivalPulse": True,
        "completionRebound": False,
    },
    "busExperimental": {
        "schematicOverview": False,
        "coverFlip": False,
        "routeIsolation": True,
        "routeStretch": True,
        "cameraFollow": True,
        "arrivalPulse": True,
        "completionRebound": True,
    },
}


def _boolean_environment(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _learn_profile(name: str, fallback: str) -> str:
    value = os.getenv(name, "").strip()
    folded = value.casefold()
    aliases = {
        "standard": "standard",
        "metrofinal": "metroFinal",
        "busexperimental": "busExperimental",
        "immersive": "metroFinal" if fallback == "metroFinal" else "busExperimental",
    }
    return aliases.get(folded, fallback)


def learn_experience_config(*, protected_geometry: bool = False) -> dict:
    """Return the shared, browser-visible Learn experience contract."""

    presets = {name: dict(capabilities) for name, capabilities in LEARN_EXPERIENCE_PRESETS.items()}
    if protected_geometry:
        for capabilities in presets.values():
            capabilities["schematicOverview"] = False
            capabilities["routeStretch"] = False
    payload = {
        "profiles": list(LEARN_EXPERIENCE_PROFILES),
        "presets": presets,
        "defaults": {
            "bus": _learn_profile("TRANSIT_LEARN_EXPERIENCE_BUS", "standard"),
            "metro": _learn_profile("TRANSIT_LEARN_EXPERIENCE_METRO", "metroFinal"),
        },
        "allowUserOverride": _boolean_environment("TRANSIT_LEARN_ALLOW_EXPERIENCE_OVERRIDE", True),
    }
    if protected_geometry:
        payload["protectedGeometry"] = True
    return payload


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
