from __future__ import annotations

import unittest

from metro.build_network import inverse_mercator, mercator, round_geo_path


class MetroGeographyTests(unittest.TestCase):
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
