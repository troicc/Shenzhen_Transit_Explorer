from __future__ import annotations

import unittest

from transit_explorer.networks.metro.builder import inverse_mercator, mercator, round_geo_path
from transit_explorer.features.schematic import compute_anchors


class MetroGeographyTests(unittest.TestCase):
    def test_default_station_normalizer_builds_cross_line_anchor(self) -> None:
        anchors = compute_anchors(
            [
                {"id": "1:forward", "route_no": "1号线", "stops": [{"name": "中心站", "x": 10, "y": 20}]},
                {"id": "2:forward", "route_no": "2号线", "stops": [{"name": "中心站", "x": 14, "y": 24}]},
            ]
        )
        self.assertIn("中心", anchors)
        self.assertEqual(anchors["中心"]["lines"], ["1号线", "2号线"])

    def test_mercator_round_trip_preserves_gcj02_coordinates(self) -> None:
        source = (114.057868, 22.543099)
        result = inverse_mercator(*mercator(*source))
        self.assertAlmostEqual(result[0], source[0], places=7)
        self.assertAlmostEqual(result[1], source[1], places=7)

    def test_public_geographic_source_path_is_rounded_and_deduplicated(self) -> None:
        result = round_geo_path(
            [
                [114.05786801, 22.54309901],
                [114.05786801, 22.54309901],
                [114.05800009, 22.54400009],
            ]
        )
        self.assertEqual(
            result,
            [[114.057868, 22.543099], [114.0580001, 22.5440001]],
        )


if __name__ == "__main__":
    unittest.main()
