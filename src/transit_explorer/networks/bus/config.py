"""Bus network paths and product metadata."""

from __future__ import annotations

from ...settings import RESOURCES_DIR, VAR_DIR


NETWORK_ID = "bus"
NETWORK_NAME = "深圳公交"
NETWORK_DIR = VAR_DIR / NETWORK_ID
DATA_DIR = NETWORK_DIR
DB_PATH = NETWORK_DIR / "network.db"
NETWORK_PATH = NETWORK_DIR / "network.json.gz"
CATALOG_PATH = RESOURCES_DIR / NETWORK_ID / "catalog.json"
