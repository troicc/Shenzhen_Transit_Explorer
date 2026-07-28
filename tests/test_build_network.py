import gzip
import json
import math
import tempfile
import unittest
from pathlib import Path

from build_network import build_focus_geometry, focus_self_intersections, publish_split_data


class FocusGeometryTests(unittest.TestCase):
    def test_focus_geometry_is_deterministic_octilinear_and_monotonic(self):
        source = [
            (0.0, 0.0),
            (70.0, 22.0),
            (145.0, 78.0),
            (210.0, 136.0),
            (302.0, 143.0),
            (388.0, 205.0),
        ]
        first = build_focus_geometry(source)
        second = build_focus_geometry(source)
        self.assertEqual(first, second)
        self.assertEqual(len(first["stationPoints"]), len(source))
        self.assertTrue(
            all(
                left < right
                for left, right in zip(
                    first["stationProgresses"], first["stationProgresses"][1:]
                )
            )
        )
        self.assertAlmostEqual(first["stationProgresses"][-1], 1.0)
        for start, end in zip(first["path"], first["path"][1:]):
            angle = math.atan2(end[1] - start[1], end[0] - start[0])
            snapped = round(angle / (math.pi / 4)) * (math.pi / 4)
            self.assertLess(abs(math.atan2(math.sin(angle - snapped), math.cos(angle - snapped))), 0.001)

    def test_crossing_source_is_rendered_without_self_intersection(self):
        geometry = build_focus_geometry(
            [(0.0, 0.0), (100.0, 100.0), (0.0, 100.0), (100.0, 0.0)]
        )
        path = [tuple(point) for point in geometry["path"]]
        self.assertEqual(focus_self_intersections(path), 0)

    def test_long_route_keeps_one_station_point_per_stop(self):
        source = [(index * 35.0, math.sin(index / 3) * 90.0) for index in range(80)]
        geometry = build_focus_geometry(source)
        self.assertEqual(len(geometry["path"]), 80)
        self.assertEqual(len(geometry["stationProgresses"]), 80)
        self.assertEqual(focus_self_intersections([tuple(point) for point in geometry["path"]]), 0)


class SplitPublishingTests(unittest.TestCase):
    def test_manifest_overview_and_route_shard_are_written(self):
        route = {
            "id": "1:down",
            "official_id": 1,
            "route_no": "1",
            "direction": "down",
            "direction_label": "下行",
            "operator": "测试公司",
            "start_stop": "甲站",
            "end_stop": "乙站",
            "score": 1.0,
            "match_state": "matched",
            "bbox": [0, 0, 10, 10],
            "paths": {"overview": [[0, 0], [10, 10]]},
            "stops": [{"name": "甲站"}, {"name": "乙站"}],
        }
        network = {
            "version": 2,
            "built_at": "2026-07-26T00:00:00+00:00",
            "world": {"width": 10000, "height": 6000},
            "stats": {"directions": 1},
            "routes": [route],
            "stations": [
                {"id": "s1", "name": "甲站", "route_ids": ["1:down"]}
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = publish_split_data(network, root)
            manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(result["route_files"], 1)
            self.assertEqual(manifest["routes"][0]["data_path"], "bus/routes/1%3Adown.json.gz")
            with gzip.open(root / "bus" / "overview.json.gz", "rt", encoding="utf-8") as handle:
                overview = json.load(handle)
            self.assertEqual(overview["routes"][0]["stop_count"], 2)
            self.assertTrue((root / "bus" / "routes" / "1%3Adown.json.gz").exists())


if __name__ == "__main__":
    unittest.main()
