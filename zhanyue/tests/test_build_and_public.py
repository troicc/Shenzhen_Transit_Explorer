from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from zhanyue import build
from zhanyue import public_server
from zhanyue.public_assets import audit_public_bundle


FIXTURES = Path(__file__).resolve().parent / "fixtures"
SAMPLE_DATA = FIXTURES / "sample_data.json"
SAMPLE_GEOGRAPHIC = FIXTURES / "sample_geographic.json"


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data, cls.raw = build.load_data(SAMPLE_DATA)

    def test_review_and_public_use_distinct_geometry_providers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            review = build.build_review(self.data, self.raw, root / "review")
            public = build.build_public(
                self.data,
                self.raw,
                root / "public",
                SAMPLE_GEOGRAPHIC,
            )
            review_html = (root / "review" / "index.html").read_text(encoding="utf-8")
            public_html = (root / "public" / "index.html").read_text(encoding="utf-8")
            scene = json.loads((root / "public" / "lines" / "1" / "scene.json").read_text(encoding="utf-8"))
            self.assertIn("导出校核 JSON", review_html)
            self.assertIn("let DATA =", review_html)
            self.assertNotIn("导出校核 JSON", public_html)
            self.assertNotIn("let DATA =", public_html)
            self.assertNotIn("d", scene)
            self.assertNotIn("points", scene)
            self.assertEqual(scene["protection"]["schematic"], "protected-raster")
            self.assertEqual(scene["stations"][0]["anchor"][0] % 8, 0)
            self.assertTrue(scene["raster"]["levels"])
            self.assertTrue(scene["segments"][0]["atlasUrls"]["forward"].endswith(".webp"))
            self.assertEqual(audit_public_bundle(root / "public"), [])
            self.assertTrue(review["buildId"].startswith("review-"))
            self.assertEqual(public["audit"], "passed")

    def test_public_bundle_contains_no_internal_assets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "public"
            build.build_public(self.data, self.raw, output, SAMPLE_GEOGRAPHIC)
            names = {path.name for path in output.rglob("*")}
            self.assertNotIn("zhanyue_metro_data.json", names)
            self.assertNotIn("metro_schematic_layout.json", names)
            self.assertNotIn("review", names)


class PublicApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        data, raw = build.load_data(SAMPLE_DATA)
        build.build_public(data, raw, public_server.DIST_DIR, SAMPLE_GEOGRAPHIC)
        public_server._json_cache.clear()
        cls.client = TestClient(public_server.app)

    def test_runtime_declares_capabilities_and_no_vector_schematic(self) -> None:
        response = self.client.get("/api/runtime")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["edition"], "public")
        self.assertTrue(payload["capabilities"]["flatMap"])
        self.assertFalse(payload["capabilities"]["vectorGeometry"])
        self.assertFalse(payload["capabilities"]["editing"])

    def test_manifest_contains_no_geometry(self) -> None:
        response = self.client.get("/api/manifest")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["lines"]), 2)
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn('"d"', serialized)
        self.assertNotIn('"points"', serialized)
        self.assertNotIn('"stations"', serialized)

    def test_scene_is_raster_only_with_quantized_anchors(self) -> None:
        response = self.client.get("/api/lines/1/scene")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn('"d"', serialized)
        self.assertNotIn('"points"', serialized)
        self.assertNotIn('"bbox"', serialized)
        self.assertIn("raster", payload)
        self.assertIn("segments", payload)
        for station in payload["stations"]:
            self.assertEqual(set(station), {"name", "pinyin", "transfer", "progress", "anchor"})
            self.assertTrue(all(coordinate % 8 == 0 for coordinate in station["anchor"]))

    def test_geographic_geometry_is_separate_from_schematic_scene(self) -> None:
        payload = self.client.get("/api/lines/1/geographic").json()
        self.assertIn("path", payload["geometry"]["gcj02"])
        self.assertEqual(payload["protection"]["geographic"], "derived-vector-quantized-5dp")
        self.assertNotIn("anchor", json.dumps(payload, ensure_ascii=False))

    def test_old_reconstructable_line_api_is_gone(self) -> None:
        self.assertEqual(self.client.get("/api/line/1").status_code, 404)

    def test_station_search_has_no_geometry(self) -> None:
        response = self.client.get("/api/search", params={"q": "罗湖"})
        self.assertEqual(response.status_code, 200)
        results = response.json()["results"]
        self.assertTrue(results)
        serialized = json.dumps(results, ensure_ascii=False)
        for key in ('"points"', '"progress"', '"anchor"', '"gcj02"'):
            self.assertNotIn(key, serialized)

    def test_public_process_is_not_mounted_to_source_geometry(self) -> None:
        payload = self.client.get("/health").json()
        self.assertFalse(payload["sourceGeometryMounted"])
        source = Path(public_server.__file__).read_text(encoding="utf-8")
        self.assertNotIn("ZHANYUE_DATA_PATH", source)
        self.assertNotIn("data/zhanyue_metro_data.json", source)

    def test_internal_routes_and_docs_are_absent(self) -> None:
        self.assertEqual(self.client.get("/docs").status_code, 404)
        self.assertEqual(self.client.get("/openapi.json").status_code, 404)
        self.assertEqual(self.client.get("/metro/studio").status_code, 404)
        self.assertEqual(self.client.post("/api/metro/schematic/save", json={}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
