from __future__ import annotations

import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from transit_explorer.editions import public as public_server
from transit_explorer.features import publishing
from transit_explorer.features.public_assets import audit_public_bundle


def write_gzip(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(str(path), "wt", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)


def source_network(network_id: str) -> dict:
    route_id = "{}-source".format(network_id)
    route = {
        "id": route_id,
        "official_id": "metro-1" if network_id == "metro" else 1,
        "route_no": "1号线" if network_id == "metro" else "测试1路",
        "short_name": "1" if network_id == "metro" else "测试1路",
        "color": "#00ab39",
        "direction": "forward" if network_id == "metro" else "down",
        "direction_label": "往丙站",
        "operator": "测试运营方",
        "start_stop": "甲站",
        "end_stop": "丙站",
        "bbox": [0, 0, 100, 30],
        "paths": {
            "overview": [[0, 0], [100, 30]],
            "medium": [[0, 0], [50, 30], [100, 0]],
            "detail": [[0, 0], [50, 30], [100, 0]],
        },
        "geometry": {
            "gcj02": {
                "path": [
                    [114.05786801, 22.54309901],
                    [114.06786801, 22.55309901],
                    [114.07786801, 22.54309901],
                ]
            }
        },
        "stops": [
            {"name": "甲站", "progress": 0, "x": 0, "y": 0},
            {"name": "乙站", "progress": 0.5, "x": 50, "y": 30},
            {"name": "丙站", "progress": 1, "x": 100, "y": 0},
        ],
    }
    if network_id == "metro":
        route["schematic"] = {
            "path": [[0, 0], [50, 50], [100, 0]],
            "station_progress": [0, 0.5, 1],
        }
    return {
        "version": 3,
        "name": "测试网络",
        "built_at": "2026-07-28T00:00:00+00:00",
        "world": {"width": 100, "height": 50},
        "stats": {"directions": 1, "station_clusters": 3},
        "routes": [route],
        "stations": [
            {"name": "甲站", "route_count": 1},
            {"name": "乙站", "route_count": 2},
            {"name": "丙站", "route_count": 1},
        ],
        "transfer_anchors": {},
    }


class PublicPipelineTests(unittest.TestCase):
    def test_fused_publish_is_audited_and_public_server_is_derivative_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bus_path = root / "bus.json.gz"
            metro_path = root / "metro.json.gz"
            language_path = root / "language.json"
            layout_path = root / "layout.json"
            first_output = root / "first-public"
            final_output = root / "final-public"
            write_gzip(bus_path, source_network("bus"))
            write_gzip(metro_path, source_network("metro"))

            patches = {
                "BUS_NETWORK": bus_path,
                "METRO_NETWORK": metro_path,
                "LANGUAGE_PATH": language_path,
                "METRO_LAYOUT": layout_path,
            }
            with mock.patch.multiple(publishing, **patches):
                first = publishing.publish_public(["bus", "metro"], first_output)
                language_path.write_text(
                    json.dumps({"version": 2, "stations": {"乙站": {"pinyin": "yi zhan test"}}}, ensure_ascii=False),
                    encoding="utf-8",
                )
                final = publishing.publish_public(["bus", "metro"], final_output)

            self.assertEqual(first["audit"], "passed")
            self.assertEqual(final["audit"], "passed")
            self.assertNotEqual(first["buildId"], final["buildId"])
            self.assertEqual(audit_public_bundle(final_output), [])
            self.assertEqual(final["networks"]["bus"]["strategy"], "raster-base-coarse-motion")
            self.assertEqual(final["networks"]["metro"]["strategy"], "raster-base-segment-atlas")

            bus_scene_path = final_output / "networks" / "bus" / "lines" / "bus-bus-source" / "scene.json"
            scene = json.loads(bus_scene_path.read_text(encoding="utf-8"))
            serialized = json.dumps(scene, ensure_ascii=False)
            for forbidden in ('"d"', '"points"', '"bbox"', '"x"', '"y"'):
                self.assertNotIn(forbidden, serialized)
            self.assertEqual(scene["motionStrategy"], "raster-base-coarse-motion")

            with mock.patch.object(public_server, "PUBLIC_DIR", final_output), mock.patch.object(public_server, "ACCESS_TOKEN", ""):
                public_server._json_cache.clear()
                public_server._line_requests.clear()
                with TestClient(public_server.app) as client:
                    self.assertEqual(client.get("/").status_code, 200)
                    networks = client.get("/api/networks")
                    self.assertEqual([item["id"] for item in networks.json()["networks"]], ["bus", "metro"])
                    public_runtime = client.get("/api/bus/runtime").json()
                    self.assertEqual(public_runtime["edition"], "public")
                    self.assertTrue(public_runtime["learnExperience"]["protectedGeometry"])
                    self.assertEqual(public_runtime["learnExperience"]["defaults"]["metro"], "metroFinal")
                    self.assertFalse(
                        public_runtime["learnExperience"]["presets"]["metroFinal"]["routeStretch"]
                    )
                    self.assertEqual(client.get("/api/metro/manifest").status_code, 200)
                    response = client.get("/api/bus/lines/bus-bus-source/scene")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.headers["x-frame-options"], "DENY")
                    geographic = client.get("/api/bus/lines/bus-bus-source/geographic").json()
                    self.assertEqual(geographic["geometry"]["gcj02"]["path"][0], [114.05787, 22.5431])
                    self.assertTrue(client.get("/api/bus/search", params={"q": "乙站"}).json()["results"])
                    self.assertEqual(client.get("/assets/bus/network-overview.png").status_code, 200)
                    health = client.get("/health").json()
                    self.assertFalse(health["sourceGeometryMounted"])
                    for path in ("/docs", "/openapi.json", "/studio", "/api/bus/build", "/api/metro/studio"):
                        self.assertEqual(client.get(path).status_code, 404, path)


if __name__ == "__main__":
    unittest.main()
