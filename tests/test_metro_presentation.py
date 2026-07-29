from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from transit_explorer.networks.metro.presentation import (
    MetroPresentationRepository,
    PresentationRevisionConflict,
)


def sample_network() -> dict:
    forward = {
        "id": "metro-1:forward",
        "official_id": "metro-1",
        "route_no": "1号线",
        "short_name": "1",
        "color": "#00ab39",
        "direction": "forward",
        "start_stop": "甲站",
        "end_stop": "丙站",
        "schematic": {
            "path": [[0, 0], [50, 50], [100, 0]],
            "station_progress": [0, 0.5, 1],
        },
        "stops": [{"name": "甲站"}, {"name": "乙站"}, {"name": "丙站"}],
    }
    reverse = {
        **{key: value for key, value in forward.items() if key != "schematic"},
        "id": "metro-1:reverse",
        "direction": "reverse",
        "start_stop": "丙站",
        "end_stop": "甲站",
        "stops": [{"name": "丙站"}, {"name": "乙站"}, {"name": "甲站"}],
    }
    return {
        "version": 3,
        "built_at": "2026-07-28T00:00:00+00:00",
        "name": "测试地铁",
        "world": {"width": 1000, "height": 600},
        "routes": [forward, reverse],
        "transfer_anchors": {
            "乙": {"name": "乙站", "x": 50, "y": 50, "lines": ["1", "2"]},
        },
    }


class MetroPresentationRepositoryTests(unittest.TestCase):
    def test_layout_is_canonical_for_forward_reverse_and_overview(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout_path = Path(directory) / "layout.json"
            layout_path.write_text(
                json.dumps(
                    {
                        "key_version": 2,
                        "alpha": 0.6,
                        "lines": {
                            "1": {
                                "path": [[10, 20], [70, 80], [130, 20]],
                                "station_progress": [0, 0.4, 1],
                            }
                        },
                        "anchors": {"乙": {"x": 72, "y": 79}},
                    }
                ),
                encoding="utf-8",
            )
            repository = MetroPresentationRepository(Path(directory) / "unused.json.gz", layout_path)
            network = repository.get_network(sample_network())

            forward = network["routes"][0]["geometry"]["focus"]
            reverse = network["routes"][1]["geometry"]["focus"]
            self.assertEqual(forward["path"], [[10.0, 20.0], [70.0, 80.0], [130.0, 20.0]])
            self.assertEqual(forward["stationProgresses"], [0.0, 0.4, 1.0])
            self.assertEqual(forward["source"], "metro-layout")
            self.assertEqual(reverse["path"], list(reversed(forward["path"])))
            self.assertEqual(reverse["stationProgresses"], [0.0, 0.6, 1.0])
            self.assertEqual(network["transfer_anchors"]["乙"]["x"], 72.0)

            presentation = repository.presentation(sample_network())
            self.assertEqual(len(presentation["routes"]), 1)
            self.assertEqual(presentation["routes"][0]["path"], forward["path"])
            self.assertEqual(
                presentation["directions"]["1"],
                {"forward": "metro-1:forward", "reverse": "metro-1:reverse"},
            )
            self.assertEqual(presentation["routes"][0]["stops"][1]["stationKey"], "乙")
            self.assertEqual(presentation["routes"][0]["stops"][1]["anchorKey"], "乙")
            self.assertTrue(presentation["revision"].startswith("metro-presentation-"))

    def test_normalization_migrates_legacy_keys_and_rejects_bad_progress(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = MetroPresentationRepository(
                Path(directory) / "unused.json.gz", Path(directory) / "layout.json"
            )
            payload = {
                "alpha": 0.55,
                "lines": {
                    "metro-1:forward": {
                        "path": [[0, 0], [50, 50], [100, 0]],
                        "station_progress": [0, 0.5, 1],
                    }
                },
                "anchors": {"乙": {"x": 55, "y": 45}},
            }
            normalized = repository.normalize_layout(payload, sample_network())
            self.assertEqual(normalized["key_version"], 2)
            self.assertEqual(list(normalized["lines"]), ["1"])
            self.assertEqual(normalized["anchors"]["乙"], {"x": 55.0, "y": 45.0})

            payload["lines"]["metro-1:forward"]["station_progress"] = [0, 0.8, 0.7]
            with self.assertRaisesRegex(ValueError, "path 或 station_progress"):
                repository.normalize_layout(payload, sample_network())

    def test_save_is_visible_through_a_new_revision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout_path = Path(directory) / "layout.json"
            repository = MetroPresentationRepository(Path(directory) / "unused.json.gz", layout_path)
            before = repository.revision(sample_network())
            normalized = repository.normalize_layout(
                {
                    "alpha": 0.5,
                    "lines": {
                        "1": {
                            "path": [[0, 0], [60, 40], [100, 0]],
                            "station_progress": [0, 0.5, 1],
                        }
                    },
                    "anchors": {"乙": {"x": 60, "y": 40}},
                },
                sample_network(),
            )
            repository.save_layout(normalized)
            after = repository.revision(sample_network())
            self.assertTrue(layout_path.is_file())
            self.assertNotEqual(before, after)

    def test_revision_checked_save_rejects_a_stale_authoring_session(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = MetroPresentationRepository(
                Path(directory) / "unused.json.gz", Path(directory) / "layout.json"
            )
            before = repository.revision(sample_network())
            payload = {
                "baseRevision": before,
                "alpha": 0.55,
                "lines": {
                    "1": {
                        "path": [[0, 0], [60, 40], [100, 0]],
                        "station_progress": [0, 0.5, 1],
                    }
                },
                "anchors": {"乙": {"x": 60, "y": 40}},
            }
            saved, after = repository.save_layout_if_revision(
                payload, sample_network(), "2026-07-29T00:00:00+00:00"
            )
            self.assertEqual(saved["saved_at"], "2026-07-29T00:00:00+00:00")
            self.assertNotEqual(before, after)
            with self.assertRaises(PresentationRevisionConflict) as context:
                repository.save_layout_if_revision(
                    payload, sample_network(), "2026-07-29T00:01:00+00:00"
                )
            self.assertEqual(context.exception.current_revision, after)


if __name__ == "__main__":
    unittest.main()
