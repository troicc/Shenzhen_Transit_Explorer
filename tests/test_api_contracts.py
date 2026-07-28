from __future__ import annotations

import gzip
import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from transit_explorer.editions.internal import app
from transit_explorer.networks.bus.service import service as bus_service
from transit_explorer.networks.metro.service import service as metro_service


def write_network(path: Path, network_id: str) -> str:
    route_id = "{}-route:forward".format(network_id)
    route = {
        "id": route_id,
        "official_id": "{}-route".format(network_id),
        "route_no": "测试线",
        "short_name": "测试",
        "color": "#12aacc",
        "direction": "forward",
        "direction_label": "往乙站",
        "operator": "测试运营方",
        "start_stop": "甲站",
        "end_stop": "乙站",
        "score": 0.98,
        "match_state": "matched",
        "bbox": [0, 0, 100, 40],
        "paths": {
            "overview": [[0, 0], [100, 40]],
            "medium": [[0, 0], [50, 20], [100, 40]],
            "detail": [[0, 0], [50, 20], [100, 40]],
        },
        "geometry": {"gcj02": {"path": [[114.05, 22.54], [114.06, 22.55]]}},
        "stops": [
            {"name": "甲站", "order": 0, "progress": 0, "x": 0, "y": 0},
            {"name": "乙站", "order": 1, "progress": 1, "x": 100, "y": 40},
        ],
    }
    network = {
        "version": 3,
        "network_id": network_id,
        "name": "测试{}网络".format(network_id),
        "built_at": "2026-07-28T00:00:00+00:00",
        "world": {"width": 100, "height": 40},
        "stats": {"directions": 1, "station_clusters": 2},
        "routes": [route],
        "stations": [
            {"id": "s1", "name": "甲站", "x": 0, "y": 0, "route_count": 1, "route_ids": [route_id], "route_nos": ["测试线"]},
            {"id": "s2", "name": "乙站", "x": 100, "y": 40, "route_count": 1, "route_ids": [route_id], "route_nos": ["测试线"]},
        ],
    }
    with gzip.open(str(path), "wt", encoding="utf-8") as handle:
        json.dump(network, handle, ensure_ascii=False)
    return route_id


class InternalApiContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.originals = []
        self.route_ids = {}
        for network_id, service in (("bus", bus_service), ("metro", metro_service)):
            self.originals.append((service, service.cache.path, service.language.path))
            path = root / "{}.json.gz".format(network_id)
            self.route_ids[network_id] = write_network(path, network_id)
            service.cache.path = path
            service.cache.clear()
            service.language.path = root / "language.json"
            service.language._mtime = -1.0
            service.language._items = {}
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.client.close()
        for service, cache_path, language_path in self.originals:
            service.cache.path = cache_path
            service.cache.clear()
            service.language.path = language_path
            service.language._mtime = -1.0
            service.language._items = {}
        self.temporary.cleanup()

    def test_bus_and_metro_share_the_same_query_contract(self) -> None:
        for network_id in ("bus", "metro"):
            route_id = self.route_ids[network_id]
            overview = self.client.get("/api/{}/network/overview".format(network_id))
            self.assertEqual(overview.status_code, 200)
            self.assertEqual(overview.json()["network_id"], network_id)
            self.assertEqual(len(overview.json()["routes"]), 1)

            viewport = self.client.get(
                "/api/{}/network/view".format(network_id),
                params={"minx": -1, "miny": -1, "maxx": 101, "maxy": 41, "zoom": 8},
            )
            self.assertEqual(viewport.status_code, 200)
            self.assertEqual(viewport.json()["level"], "detail")

            route = self.client.get("/api/{}/network/routes/{}".format(network_id, route_id))
            learning = self.client.get("/api/{}/learn/routes/{}".format(network_id, route_id))
            search = self.client.get("/api/{}/search".format(network_id), params={"q": "乙站"})
            self.assertEqual(route.status_code, 200)
            self.assertEqual(learning.status_code, 200)
            self.assertEqual(learning.json()["network_id"], network_id)
            self.assertEqual(learning.json()["stops"][1]["name"], "乙站")
            self.assertTrue(search.json()["results"])

    def test_shared_pages_and_removed_legacy_routes(self) -> None:
        for path in ("/", "/bus", "/metro", "/bus/collector", "/metro/collector", "/bus/learn", "/metro/learn", "/studio"):
            self.assertEqual(self.client.get(path).status_code, 200, path)
        runtime = self.client.get("/api/runtime").json()
        self.assertEqual(runtime["edition"], "internal")
        self.assertEqual(runtime["networks"], ["bus", "metro"])
        for path in ("/collector", "/learn", "/api/network/overview", "/api/metro/schematic"):
            self.assertEqual(self.client.get(path).status_code, 404, path)


if __name__ == "__main__":
    unittest.main()
