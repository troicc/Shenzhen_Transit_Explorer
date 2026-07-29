"""Shared network query, learning and API implementation.

Bus and metro provide data and small policy functions.  Viewport selection,
route lookup, station-language enrichment and search live here once.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .cache import NetworkCache
from .language import StationLanguageStore
from .speech import CantoneseSpeechUnavailable, synthesize_cantonese


Normalizer = Callable[[str], str]
LineCount = Callable[[Dict[str, Any]], int]


@dataclass(frozen=True)
class NetworkSpec:
    network_id: str
    name: str
    network_path: Path
    language_path: Path
    normalize_station: Normalizer
    cluster_line_count: LineCount
    missing_detail: str
    default_operator: str
    route_search_fields: Sequence[str]
    station_zoom: float = 2.4
    station_cap: Optional[int] = None
    default_color: str = "#5cc8ff"


class StationLanguageRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    pinyin: Optional[str] = Field(default=None, max_length=300)
    jyutping: Optional[str] = Field(default=None, max_length=300)
    audio_url: Optional[str] = Field(default=None, max_length=1000)
    note: Optional[str] = Field(default=None, max_length=1000)


def intersects(bbox: Sequence[float], view: Tuple[float, float, float, float]) -> bool:
    if len(bbox) != 4:
        return False
    min_x, min_y, max_x, max_y = (float(value) for value in bbox)
    view_min_x, view_min_y, view_max_x, view_max_y = view
    return max_x >= view_min_x and min_x <= view_max_x and max_y >= view_min_y and min_y <= view_max_y


class NetworkService:
    def __init__(self, spec: NetworkSpec):
        self.spec = spec
        self.cache = NetworkCache(spec.network_path)
        self.language = StationLanguageStore(spec.language_path)

    def require_network(self) -> Dict[str, Any]:
        try:
            return self.cache.get()
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=self.spec.missing_detail) from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=503, detail="线网文件损坏或暂时不可读") from exc

    def overview(self) -> Dict[str, Any]:
        network = self.require_network()
        routes = []
        for route in network.get("routes", []):
            routes.append(
                {
                    "id": route["id"],
                    "official_id": route.get("official_id"),
                    "route_no": route.get("route_no", ""),
                    "short_name": route.get("short_name"),
                    "color": route.get("color"),
                    "direction": route.get("direction", ""),
                    "direction_label": route.get("direction_label", ""),
                    "operator": route.get("operator", self.spec.default_operator),
                    "start_stop": route.get("start_stop", ""),
                    "end_stop": route.get("end_stop", ""),
                    "score": route.get("score", 0),
                    "match_state": route.get("match_state", "matched"),
                    "bbox": route.get("bbox", []),
                    "path": route.get("paths", {}).get("overview", []),
                    "stop_count": len(route.get("stops", [])),
                }
            )
        return {
            "version": network.get("version"),
            "network_id": self.spec.network_id,
            "name": network.get("name") or self.spec.name,
            "built_at": network.get("built_at"),
            "world": network.get("world"),
            "stats": network.get("stats", {}),
            "routes": routes,
        }

    def viewport(self, bounds: Tuple[float, float, float, float], zoom: float) -> Dict[str, Any]:
        network = self.require_network()
        min_x, min_y, max_x, max_y = bounds
        view = (min(min_x, max_x), min(min_y, max_y), max(min_x, max_x), max(min_y, max_y))
        level = "overview" if zoom < 2.2 else "medium" if zoom < 6 else "detail"
        routes = []
        for route in network.get("routes", []):
            if intersects(route.get("bbox", []), view):
                routes.append(
                    {
                        "id": route["id"],
                        "route_no": route.get("route_no", ""),
                        "color": route.get("color"),
                        "direction": route.get("direction", ""),
                        "bbox": route.get("bbox", []),
                        "path": route.get("paths", {}).get(level, []),
                        "score": route.get("score", 0),
                        "match_state": route.get("match_state", "matched"),
                    }
                )
        stations: List[Dict[str, Any]] = []
        if zoom >= self.spec.station_zoom:
            stations = [
                station
                for station in network.get("stations", [])
                if view[0] <= float(station.get("x", 0)) <= view[2]
                and view[1] <= float(station.get("y", 0)) <= view[3]
            ]
            if self.spec.station_cap and len(stations) > self.spec.station_cap:
                stations.sort(
                    key=lambda item: (int(item.get("route_count", 0)), int(item.get("samples", 0))),
                    reverse=True,
                )
                stations = stations[: self.spec.station_cap]
        return {"level": level, "routes": routes, "stations": stations}

    def route(self, route_id: str) -> Dict[str, Any]:
        self.require_network()
        route = self.cache.route_map.get(route_id)
        if route is None:
            raise HTTPException(status_code=404, detail="线路不存在")
        return route

    def _cluster_index(self, network: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
        index: Dict[str, List[Dict[str, Any]]] = {}
        for station in network.get("stations", []):
            key = self.spec.normalize_station(str(station.get("name", "")))
            index.setdefault(key, []).append(station)
        return index

    def _nearest_cluster(
        self, stop: Dict[str, Any], index: Dict[str, List[Dict[str, Any]]]
    ) -> Optional[Dict[str, Any]]:
        key = self.spec.normalize_station(str(stop.get("name", "")))
        candidates = index.get(key, [])
        if not candidates:
            return None
        x = float(stop.get("x", 0))
        y = float(stop.get("y", 0))
        return min(
            candidates,
            key=lambda item: (float(item.get("x", 0)) - x) ** 2
            + (float(item.get("y", 0)) - y) ** 2,
        )

    def learning_route(self, route_id: str) -> Dict[str, Any]:
        network = self.require_network()
        route = self.cache.route_map.get(route_id)
        if route is None:
            raise HTTPException(status_code=404, detail="线路不存在")
        cluster_index = self._cluster_index(network)
        stops = []
        for stop in route.get("stops", []):
            language = self.language.get(str(stop.get("name", "")))
            cluster = self._nearest_cluster(stop, cluster_index)
            line_count = self.spec.cluster_line_count(cluster) if cluster else 1
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
                    "route_nos": cluster.get("route_nos", []) if cluster else [route.get("route_no")],
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
            "color": route.get("color", self.spec.default_color),
            "name": "{} · {}".format(
                route.get("route_no", ""),
                route.get("direction_label", route.get("direction", "")),
            ),
            "direction": route.get("direction", ""),
            "direction_label": route.get("direction_label", ""),
            "operator": route.get("operator", self.spec.default_operator),
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
            "network_id": self.spec.network_id,
            "network_type": self.spec.network_id,
        }

    def update_language(self, payload: StationLanguageRequest) -> Dict[str, Any]:
        try:
            item = self.language.update(
                name=payload.name,
                pinyin=payload.pinyin,
                jyutping=payload.jyutping,
                audio_url=payload.audio_url,
                note=payload.note,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "item": item}

    def export_language(self) -> JSONResponse:
        return JSONResponse(
            self.language.export(),
            headers={"Content-Disposition": 'attachment; filename="station-language.json"'},
        )

    def search(self, query: str, limit: int) -> Dict[str, Any]:
        network = self.require_network()
        folded = query.strip().casefold()
        results: List[Dict[str, Any]] = []
        seen_routes: Set[str] = set()
        for route in network.get("routes", []):
            haystack = " ".join(str(route.get(field, "")) for field in self.spec.route_search_fields).casefold()
            route_id = str(route.get("id", ""))
            if folded in haystack and route_id not in seen_routes:
                results.append(
                    {
                        "type": "route",
                        "id": route_id,
                        "title": "{} · {}".format(route.get("route_no", ""), route.get("direction_label", "")),
                        "subtitle": "{} → {}".format(route.get("start_stop", ""), route.get("end_stop", "")),
                        "bbox": route.get("bbox", []),
                    }
                )
                seen_routes.add(route_id)
                if len(results) >= limit:
                    break
        if len(results) < limit:
            for station in network.get("stations", []):
                if folded in str(station.get("name", "")).casefold():
                    results.append(
                        {
                            "type": "station",
                            "id": station.get("id"),
                            "title": station.get("name", ""),
                            "subtitle": "经过 {} 条方向线路".format(station.get("route_count", 0)),
                            "x": station.get("x"),
                            "y": station.get("y"),
                            "route_ids": station.get("route_ids", []),
                        }
                    )
                    if len(results) >= limit:
                        break
        return {"results": results}


def create_network_router(service: NetworkService) -> APIRouter:
    router = APIRouter(prefix="/api/{}".format(service.spec.network_id), tags=[service.spec.name])

    @router.get("/network/overview")
    def overview() -> Dict[str, Any]:
        return service.overview()

    @router.get("/network/view")
    def viewport(
        minx: float,
        miny: float,
        maxx: float,
        maxy: float,
        zoom: float = Query(1.0, ge=0.1, le=100),
    ) -> Dict[str, Any]:
        return service.viewport((minx, miny, maxx, maxy), zoom)

    @router.get("/network/routes/{route_id}")
    def route(route_id: str) -> Dict[str, Any]:
        return service.route(route_id)

    @router.get("/learn/routes/{route_id}")
    def learning_route(route_id: str) -> Dict[str, Any]:
        return service.learning_route(route_id)

    @router.post("/learn/language")
    def update_language(payload: StationLanguageRequest) -> Dict[str, Any]:
        return service.update_language(payload)

    @router.get("/learn/language/export")
    def export_language() -> JSONResponse:
        return service.export_language()

    @router.get("/learn/speech")
    def cantonese_speech(
        request: Request,
        text: str = Query(..., min_length=1, max_length=120),
    ) -> Response:
        try:
            audio = synthesize_cantonese(text)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except CantoneseSpeechUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=86400",
            "Content-Encoding": "identity",
            "X-Transit-Voice": audio.voice,
        }
        range_header = request.headers.get("range", "").strip()
        if range_header.startswith("bytes="):
            requested = range_header[6:].split(",", 1)[0]
            start_text, separator, end_text = requested.partition("-")
            try:
                if not separator:
                    raise ValueError
                if start_text:
                    start = int(start_text)
                    end = int(end_text) if end_text else len(audio.content) - 1
                else:
                    suffix = int(end_text)
                    start = max(0, len(audio.content) - suffix)
                    end = len(audio.content) - 1
                if start < 0 or end < start or start >= len(audio.content):
                    raise ValueError
                end = min(end, len(audio.content) - 1)
            except ValueError:
                return Response(
                    status_code=416,
                    headers={**headers, "Content-Range": "bytes */{}".format(len(audio.content))},
                )
            headers["Content-Range"] = "bytes {}-{}/{}".format(start, end, len(audio.content))
            return Response(
                content=audio.content[start : end + 1],
                status_code=206,
                media_type="audio/wav",
                headers=headers,
            )
        return Response(content=audio.content, media_type="audio/wav", headers=headers)

    @router.get("/search")
    def search(
        q: str = Query("", min_length=1, max_length=80),
        limit: int = Query(30, ge=1, le=100),
    ) -> Dict[str, Any]:
        return service.search(q, limit)

    return router
