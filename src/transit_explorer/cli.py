"""Unified command-line interface for the complete project lifecycle."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from . import __version__
from .networks.bus import builder as bus_builder
from .networks.bus.config import CATALOG_PATH as BUS_CATALOG
from .networks.bus.config import DB_PATH as BUS_DB
from .networks.bus.config import NETWORK_PATH as BUS_NETWORK
from .networks.metro import builder as metro_builder
from .networks.metro.config import DB_PATH as METRO_DB
from .networks.metro.config import NETWORK_PATH as METRO_NETWORK
from .networks.metro.config import OFFICIAL_PATH as METRO_CATALOG
from .settings import PROJECT_ROOT, PUBLIC_DIR, VAR_DIR


def _emit(payload: Dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def doctor() -> int:
    checks = [
        ("python", sys.version_info >= (3, 9), "{}.{}.{}".format(*sys.version_info[:3])),
        ("project", PROJECT_ROOT.is_dir(), str(PROJECT_ROOT)),
        ("environment", (PROJECT_ROOT / ".env").is_file(), str(PROJECT_ROOT / ".env")),
        ("amap_key", bool(os.getenv("AMAP_JS_KEY", "").strip()), "AMAP_JS_KEY"),
        ("bus_catalog", BUS_CATALOG.is_file(), str(BUS_CATALOG)),
        ("metro_catalog", METRO_CATALOG.is_file(), str(METRO_CATALOG)),
        ("bus_database", BUS_DB.is_file(), str(BUS_DB)),
        ("metro_database", METRO_DB.is_file(), str(METRO_DB)),
        ("bus_network", BUS_NETWORK.is_file(), str(BUS_NETWORK)),
        ("metro_network", METRO_NETWORK.is_file(), str(METRO_NETWORK)),
        ("public_bundle", (PUBLIC_DIR / "index.html").is_file(), str(PUBLIC_DIR)),
    ]
    payload = {
        "ok": all(ok for name, ok, detail in checks if name in {"python", "project", "bus_catalog", "metro_catalog"}),
        "version": __version__,
        "var": str(VAR_DIR),
        "checks": [{"name": name, "ok": ok, "detail": detail} for name, ok, detail in checks],
        "next": {
            "collect": "transit-explorer serve internal",
            "build": "transit-explorer build all",
            "publish": "transit-explorer publish public",
        },
    }
    _emit(payload)
    return 0 if payload["ok"] else 1


def build_networks(network: str, matched_only: bool = False, no_schematic: bool = False) -> int:
    results: Dict[str, Any] = {}
    if network in {"bus", "all"}:
        results["bus"] = bus_builder.build(BUS_DB, BUS_NETWORK, include_review=not matched_only)
    if network in {"metro", "all"}:
        results["metro"] = metro_builder.build(
            METRO_DB,
            METRO_NETWORK,
            schematic=not no_schematic,
        )
    _emit({"ok": True, "results": results})
    return 0


def publish(network: Optional[str]) -> int:
    from .features.publishing import publish_public

    selected = [network] if network else ["bus", "metro"]
    result = publish_public(selected)
    _emit({"ok": True, "result": result})
    return 0


def serve(edition: str, host: Optional[str], port: Optional[int], reload: bool) -> int:
    import uvicorn

    if edition == "internal":
        target = "transit_explorer.editions.internal:app"
        bind_host = host or "127.0.0.1"
        bind_port = port or 8000
    else:
        target = "transit_explorer.editions.public:app"
        bind_host = host or os.getenv("TRANSIT_PUBLIC_HOST", "127.0.0.1")
        bind_port = port or int(os.getenv("TRANSIT_PUBLIC_PORT", "8010"))
    uvicorn.run(target, host=bind_host, port=bind_port, reload=reload)
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="transit-explorer", description="深圳公交与地铁统一工具链")
    root.add_argument("--version", action="version", version=__version__)
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor", help="检查环境、目录数据和构建产物")

    build_parser = commands.add_parser("build", help="构建一个或全部交通网络")
    build_parser.add_argument("network", choices=["bus", "metro", "all"])
    build_parser.add_argument("--matched-only", action="store_true", help="公交只纳入完全确认的方向")
    build_parser.add_argument("--no-schematic", action="store_true", help="地铁跳过示意几何生成")

    publish_parser = commands.add_parser("publish", help="生成只读公开派生应用")
    publish_parser.add_argument("edition", choices=["public"])
    publish_parser.add_argument("--network", choices=["bus", "metro"])

    serve_parser = commands.add_parser("serve", help="启动内部制作版或公开只读版")
    serve_parser.add_argument("edition", choices=["internal", "public"])
    serve_parser.add_argument("--host")
    serve_parser.add_argument("--port", type=int)
    serve_parser.add_argument("--reload", action="store_true")
    return root


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "doctor":
        return doctor()
    if args.command == "build":
        return build_networks(args.network, args.matched_only, args.no_schematic)
    if args.command == "publish":
        return publish(args.network)
    if args.command == "serve":
        return serve(args.edition, args.host, args.port, args.reload)
    raise AssertionError("unreachable")
