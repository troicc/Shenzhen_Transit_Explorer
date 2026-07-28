"""Metro network paths, catalogue source and line palette."""

from __future__ import annotations

from ...settings import RESOURCES_DIR, VAR_DIR


NETWORK_ID = "metro"
NETWORK_NAME = "深圳地铁"
NETWORK_DIR = VAR_DIR / NETWORK_ID
DATA_DIR = NETWORK_DIR
DB_PATH = NETWORK_DIR / "network.db"
NETWORK_PATH = NETWORK_DIR / "network.json.gz"
LAYOUT_PATH = NETWORK_DIR / "layout.json"
OFFICIAL_PATH = RESOURCES_DIR / NETWORK_ID / "catalog.json"
SEED_PATH = RESOURCES_DIR / NETWORK_ID / "catalog.seed.json"
SOURCE_URL = "https://jtys.sz.gov.cn/jtzx/wycx/dtcx/dtxl/content/post_12601089.html"

LINE_COLORS = {
    "1号线": "#00ab39",
    "2号线&8号线": "#db6d1c",
    "3号线": "#33ccff",
    "4号线": "#dc241f",
    "5号线": "#9950b2",
    "6号线": "#3abca8",
    "6号线支线": "#008269",
    "7号线": "#0035ad",
    "9号线": "#846e74",
    "10号线": "#ffabcb",
    "11号线": "#6a1d44",
    "12号线": "#a192b2",
    "13号线": "#ffaa55",
    "14号线": "#f2c75c",
    "16号线": "#1e22aa",
    "20号线": "#6bd9de",
}
