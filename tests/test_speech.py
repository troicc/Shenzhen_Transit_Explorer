from __future__ import annotations

import unittest

from transit_explorer.common.speech import find_cantonese_voice


class CantoneseSpeechTests(unittest.TestCase):
    def test_prefers_sinji_from_say_catalog(self) -> None:
        catalog = """
Ting-Ting           zh_CN    # 您好
Hoi Yan             yue_HK   # 你好
Sin-ji              zh_HK    # 您好，我講廣東話。
"""
        self.assertEqual(find_cantonese_voice(catalog), "Sin-ji")

    def test_does_not_accept_mandarin_or_taiwanese_voice(self) -> None:
        catalog = """
Ting-Ting           zh_CN    # 您好
Mei-Jia             zh_TW    # 您好
"""
        self.assertIsNone(find_cantonese_voice(catalog))


if __name__ == "__main__":
    unittest.main()
