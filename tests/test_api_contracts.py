from __future__ import annotations

import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from transit_explorer.editions.internal import app
from transit_explorer.common.speech import CantoneseAudio, CantoneseSpeechUnavailable
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
        self.presentation_original = (
            metro_service.presentation_repository.network_path,
            metro_service.presentation_repository.layout_path,
        )
        metro_service.presentation_repository.layout_path = root / "metro-layout.json"
        metro_service.presentation_repository.invalidate()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.client.close()
        for service, cache_path, language_path in self.originals:
            service.cache.path = cache_path
            service.cache.clear()
            service.language.path = language_path
            service.language._mtime = -1.0
            service.language._items = {}
        (
            metro_service.presentation_repository.network_path,
            metro_service.presentation_repository.layout_path,
        ) = self.presentation_original
        metro_service.presentation_repository.invalidate()
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
            if network_id == "metro":
                self.assertIn("focus", learning.json()["geometry"])

    def test_bus_and_metro_share_native_cantonese_speech(self) -> None:
        audio = CantoneseAudio(content=b"\x00\x00\x00\x18ftypM4A test-audio", voice="Sin-ji")
        with mock.patch("transit_explorer.common.network.synthesize_cantonese", return_value=audio) as synthesize:
            for network_id in ("bus", "metro"):
                response = self.client.get(
                    "/api/{}/learn/speech".format(network_id),
                    params={"text": "会展中心"},
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"], "audio/mp4")
                self.assertEqual(response.headers["x-transit-voice"], "Sin-ji")
                self.assertEqual(response.content, audio.content)
        self.assertEqual(synthesize.call_count, 2)

    def test_native_cantonese_speech_reports_service_failure(self) -> None:
        with mock.patch(
            "transit_explorer.common.network.synthesize_cantonese",
            side_effect=CantoneseSpeechUnavailable("macOS 未提供粤语（香港）系统声音"),
        ):
            response = self.client.get("/api/bus/learn/speech", params={"text": "福田"})
        self.assertEqual(response.status_code, 503)
        self.assertIn("粤语（香港）", response.json()["detail"])

    def test_metro_studio_save_immediately_updates_learn_and_presentation(self) -> None:
        before = self.client.get("/api/metro/presentation")
        self.assertEqual(before.status_code, 200)
        self.assertEqual(len(before.json()["routes"]), 1)
        before_revision = before.json()["revision"]

        studio = self.client.get("/api/metro/studio").json()
        self.assertEqual(studio["routes"][0]["stops"][0]["stationKey"], "甲")
        self.assertIsNone(studio["routes"][0]["stops"][0]["anchorKey"])
        payload = {
            "baseRevision": before_revision,
            "alpha": 0.55,
            "lines": {
                "测试": {
                    "path": [[10, 10], [110, 50]],
                    "station_progress": [0, 1],
                }
            },
            "anchors": {},
        }
        saved = self.client.post("/api/metro/studio", json=payload)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["message"], "已保存并应用到地铁练习")
        self.assertNotEqual(saved.json()["revision"], before_revision)
        self.assertIn("layoutRevision=", saved.json()["learnUrl"])

        route_id = self.route_ids["metro"]
        learning = self.client.get("/api/metro/learn/routes/{}".format(route_id)).json()
        self.assertEqual(learning["geometry"]["focus"]["path"], [[10.0, 10.0], [110.0, 50.0]])
        self.assertEqual(learning["presentation_revision"], saved.json()["revision"])
        revision = self.client.get("/api/metro/presentation/revision").json()
        self.assertEqual(revision["revision"], saved.json()["revision"])

        stale = self.client.post("/api/metro/studio", json=payload)
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(stale.json()["detail"]["code"], "revision_conflict")
        self.assertEqual(stale.json()["detail"]["currentRevision"], saved.json()["revision"])

        missing_revision = self.client.post(
            "/api/metro/studio",
            json={key: value for key, value in payload.items() if key != "baseRevision"},
        )
        self.assertEqual(missing_revision.status_code, 400, missing_revision.text)

    def test_shared_pages_and_removed_legacy_routes(self) -> None:
        for path in ("/", "/bus", "/metro", "/bus/collector", "/metro/collector", "/bus/learn", "/metro/learn", "/studio"):
            self.assertEqual(self.client.get(path).status_code, 200, path)
        runtime = self.client.get("/api/runtime").json()
        self.assertEqual(runtime["edition"], "internal")
        self.assertEqual(runtime["networks"], ["bus", "metro"])
        self.assertEqual(
            runtime["learnExperience"]["profiles"],
            ["standard", "metroFinal", "busExperimental"],
        )
        self.assertIn(runtime["learnExperience"]["defaults"]["bus"], runtime["learnExperience"]["profiles"])
        self.assertIn(runtime["learnExperience"]["defaults"]["metro"], runtime["learnExperience"]["profiles"])
        self.assertTrue(runtime["learnExperience"]["presets"]["metroFinal"]["routeStretch"])
        for path in ("/collector", "/learn", "/api/network/overview", "/api/metro/schematic"):
            self.assertEqual(self.client.get(path).status_code, 404, path)

    def test_runtime_validates_learn_experience_environment(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {
                "TRANSIT_LEARN_EXPERIENCE_BUS": "immersive",
                "TRANSIT_LEARN_EXPERIENCE_METRO": "invalid",
                "TRANSIT_LEARN_ALLOW_EXPERIENCE_OVERRIDE": "false",
            },
        ):
            learn = self.client.get("/api/runtime").json()["learnExperience"]
        self.assertEqual(learn["defaults"], {"bus": "busExperimental", "metro": "metroFinal"})
        self.assertFalse(learn["allowUserOverride"])


if __name__ == "__main__":
    unittest.main()
