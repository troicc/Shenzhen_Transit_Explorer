"""Thread-safe file-backed JSON cache used by every network service."""

from __future__ import annotations

import gzip
import json
import threading
from pathlib import Path
from typing import Any, Dict, Optional


class NetworkCache:
    """Reload a generated network only when its source file changes."""

    def __init__(self, path: Path):
        self.path = path
        self._mtime_ns = -1
        self._data: Optional[Dict[str, Any]] = None
        self._lock = threading.Lock()
        self.route_map: Dict[str, Dict[str, Any]] = {}

    def clear(self) -> None:
        with self._lock:
            self._mtime_ns = -1
            self._data = None
            self.route_map = {}

    def get(self) -> Dict[str, Any]:
        if not self.path.is_file():
            raise FileNotFoundError(str(self.path))
        mtime_ns = self.path.stat().st_mtime_ns
        if self._data is None or mtime_ns != self._mtime_ns:
            with self._lock:
                mtime_ns = self.path.stat().st_mtime_ns
                if self._data is None or mtime_ns != self._mtime_ns:
                    opener = gzip.open if self.path.suffix == ".gz" else open
                    with opener(str(self.path), "rt", encoding="utf-8") as handle:
                        payload = json.load(handle)
                    if not isinstance(payload, dict):
                        raise ValueError("线网文件顶层必须是 JSON 对象")
                    self._data = payload
                    self._mtime_ns = mtime_ns
                    self.route_map = {
                        str(item["id"]): item
                        for item in payload.get("routes", [])
                        if isinstance(item, dict) and "id" in item
                    }
        return self._data
