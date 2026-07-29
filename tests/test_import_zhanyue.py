from __future__ import annotations

import copy
import gzip
import json
import tempfile
import unittest
from pathlib import Path

from transit_explorer.features.import_zhanyue import (
    ZhanyueImportError,
    apply_import_bundle,
    build_zhanyue_import,
    parse_svg_path,
    write_import_bundle,
)


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "zhanyue-v3"


def sample_network() -> dict:
    def route(route_id: str, short_name: str, route_no: str, names: list[str]) -> dict:
        return {
            "id": route_id,
            "official_id": route_id.split(":", 1)[0],
            "short_name": short_name,
            "route_no": route_no,
            "direction": "forward",
            "start_stop": names[0],
            "end_stop": names[-1],
            "stops": [{"name": name} for name in names],
        }

    first = route("metro-1:forward", "1", "1号线", ["起点", "中站", "甲终点"])
    branch = route("metro-6-branch:forward", "6支", "6号线支线", ["中站", "支线中点", "支线终点"])
    reverse = []
    for item in (first, branch):
        clone = copy.deepcopy(item)
        clone["id"] = clone["id"].replace(":forward", ":reverse")
        clone["direction"] = "reverse"
        clone["stops"].reverse()
        reverse.append(clone)
    return {
        "version": 3,
        "built_at": "2026-07-29T00:00:00+00:00",
        "world": {"width": 1000, "height": 500},
        "schematic_alpha": 0.55,
        "routes": [first, branch, *reverse],
        "transfer_anchors": {"中": {"name": "中站", "x": 500, "y": 0, "lines": ["1", "6支"]}},
    }


class ZhanyueImporterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.data = json.loads((FIXTURE_DIR / "snapshot-data.json").read_text(encoding="utf-8"))
        self.line_map = json.loads((FIXTURE_DIR / "line-id-map.json").read_text(encoding="utf-8"))
        self.expected = json.loads((FIXTURE_DIR / "expected-layout.json").read_text(encoding="utf-8"))
        self.network_path = self.root / "network.json.gz"
        with gzip.open(self.network_path, "wt", encoding="utf-8") as handle:
            json.dump(sample_network(), handle, ensure_ascii=False)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_html(self, payload: dict, name: str = "fixture.html") -> Path:
        path = self.root / name
        path.write_text(
            "<!doctype html><script>let DATA = {};\n</script>".format(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            ),
            encoding="utf-8",
        )
        return path

    def test_all_lines_map_and_emit_canonical_artifacts(self) -> None:
        bundle = build_zhanyue_import(
            self.write_html(self.data),
            self.network_path,
            line_map=self.line_map,
            imported_at="2026-07-29T00:00:00+00:00",
        )
        self.assertTrue(bundle["report"]["ok"])
        self.assertEqual(bundle["report"]["summary"]["mappedLines"], 2)
        self.assertEqual(bundle["layout"]["lines"], self.expected["lines"])
        self.assertEqual(bundle["layout"]["anchors"], self.expected["anchors"])
        self.assertEqual(bundle["layout"]["source"]["format"], "zhanyue-v3")
        self.assertEqual(bundle["language"]["stations"]["中站"]["pinyin"], "zhong zhan")
        self.assertIn("6支:支线终点", bundle["review"]["items"])

        paths = write_import_bundle(bundle, self.root / "output")
        self.assertEqual(set(paths), {"layout", "language", "review", "report"})
        self.assertTrue(all(Path(path).is_file() for path in paths.values()))

    def test_station_sequence_conflict_is_explicit_and_blocks_artifacts(self) -> None:
        payload = copy.deepcopy(self.data)
        payload["lines"][0]["stations"][1]["name"] = "错误站名"
        with self.assertRaises(ZhanyueImportError) as context:
            build_zhanyue_import(self.write_html(payload), self.network_path, line_map=self.line_map)
        report = context.exception.report
        self.assertFalse(report["ok"])
        conflict = next(item for item in report["lineMappings"] if item["sourceId"] == "1")
        self.assertEqual(conflict["status"], "conflict")
        self.assertIn("站序", conflict["reason"])

    def test_language_conflicts_are_reported_without_silent_overwrite(self) -> None:
        payload = copy.deepcopy(self.data)
        payload["lines"][1]["stations"][0]["pinyin"] = "different value"
        bundle = build_zhanyue_import(self.write_html(payload), self.network_path, line_map=self.line_map)
        self.assertEqual(bundle["language"]["stations"]["中站"]["pinyin"], "zhong zhan")
        conflict = bundle["report"]["languageConflicts"][0]
        self.assertEqual(conflict["station"], "中站")
        self.assertEqual(conflict["field"], "pinyin")
        self.assertEqual(conflict["values"], ["zhong zhan", "different value"])

    def test_apply_preserves_existing_manual_language_and_review(self) -> None:
        bundle = build_zhanyue_import(self.write_html(self.data), self.network_path, line_map=self.line_map)
        layout_path = self.root / "var" / "metro" / "layout.json"
        language_path = self.root / "var" / "shared" / "language.json"
        review_path = self.root / "var" / "shared" / "review.json"
        language_path.parent.mkdir(parents=True)
        language_path.write_text(
            json.dumps({"version": 2, "stations": {"中站": {"pinyin": "manual"}}}),
            encoding="utf-8",
        )
        review_path.write_text(
            json.dumps({"version": 1, "items": {"1:中站": {"status": "confirmed"}}}),
            encoding="utf-8",
        )
        result = apply_import_bundle(
            bundle,
            layout_path=layout_path,
            language_path=language_path,
            review_path=review_path,
        )
        language = json.loads(language_path.read_text(encoding="utf-8"))
        review = json.loads(review_path.read_text(encoding="utf-8"))
        self.assertEqual(language["stations"]["中站"]["pinyin"], "manual")
        self.assertTrue(result["preservedManualLanguageFields"])
        self.assertEqual(review["items"]["1:中站"]["status"], "confirmed")
        self.assertTrue(layout_path.is_file())

    def test_svg_parser_supports_relative_line_and_axis_commands(self) -> None:
        self.assertEqual(
            parse_svg_path("M 1 2 h 3 v 4 l -1 -2"),
            [[1.0, 2.0], [4.0, 2.0], [4.0, 6.0], [3.0, 4.0]],
        )
        with self.assertRaisesRegex(ZhanyueImportError, "不支持"):
            parse_svg_path("M 0 0 C 1 1 2 2 3 3")


if __name__ == "__main__":
    unittest.main()
