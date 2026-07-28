"""Internal authoring application for collection, review and learning."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Dict

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .. import __version__
from ..networks.bus.router import initialize as initialize_bus
from ..networks.bus.router import router as bus_router
from ..networks.metro.router import initialize as initialize_metro
from ..networks.metro.router import router as metro_router
from ..settings import WEB_DIR, browser_map_config, learn_experience_config


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_bus()
    initialize_metro()
    yield


def create_app() -> FastAPI:
    application = FastAPI(
        title="深圳交通探索器 · 内部制作版",
        version=__version__,
        lifespan=lifespan,
    )
    application.add_middleware(GZipMiddleware, minimum_size=1000)
    application.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
    application.include_router(bus_router)
    application.include_router(metro_router)

    @application.get("/", include_in_schema=False)
    def home() -> FileResponse:
        return FileResponse(WEB_DIR / "pages" / "home.html")

    @application.get("/api/runtime")
    def runtime(request: Request) -> JSONResponse:
        host = request.client.host if request.client else ""
        include_security = host in {"127.0.0.1", "::1", "localhost", "testclient"}
        return JSONResponse(
            {
                "edition": "internal",
                "version": __version__,
                "networks": ["bus", "metro"],
                "capabilities": {
                    "collection": True,
                    "editing": True,
                    "publishing": False,
                },
                "amap": browser_map_config(include_security_code=include_security),
                "learnExperience": learn_experience_config(),
            }
        )

    @application.get("/health", include_in_schema=False)
    def health() -> Dict[str, Any]:
        return {"ok": True, "edition": "internal", "version": __version__}

    return application


app = create_app()
