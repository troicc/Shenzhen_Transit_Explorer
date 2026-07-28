from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"
DB_PATH = DATA_DIR / "metro.db"
OFFICIAL_PATH = DATA_DIR / "metro_official.json"
SEED_PATH = DATA_DIR / "metro_official_seed.json"
NETWORK_PATH = DATA_DIR / "metro_network.json.gz"
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
