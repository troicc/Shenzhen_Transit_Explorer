"""Shared station-language persistence."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from pypinyin import Style, lazy_pinyin
except ImportError:  # pragma: no cover - dependency is optional at import time.
    Style = None
    lazy_pinyin = None

_SPACE_RE = re.compile(r"\s+")


class StationLanguageStore:
    """Station language overrides with automatic Mandarin pinyin fallback.

    The persistent file is keyed by station name because pronunciation normally belongs
    to the name rather than a route occurrence. Jyutping is intentionally manual: an
    automatic Cantonese transcription would be misleading for local place names.
    """

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._mtime = -1.0
        self._items: Dict[str, Dict[str, Any]] = {}

    def _load_if_needed(self) -> None:
        with self._lock:
            if not self.path.exists():
                self._items = {}
                self._mtime = -1.0
                return
            mtime = self.path.stat().st_mtime
            if mtime == self._mtime:
                return
            try:
                payload = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                payload = {}
            raw_items = payload.get("stations", payload) if isinstance(payload, dict) else {}
            self._items = {
                str(name): dict(value)
                for name, value in raw_items.items()
                if isinstance(name, str) and isinstance(value, dict)
            }
            self._mtime = mtime

    @staticmethod
    def auto_pinyin(name: str) -> str:
        if not name or lazy_pinyin is None or Style is None:
            return ""
        parts = lazy_pinyin(
            name,
            style=Style.NORMAL,
            neutral_tone_with_five=False,
            errors=lambda text: list(text),
        )
        return _SPACE_RE.sub(" ", " ".join(str(part).lower() for part in parts)).strip()

    def get(self, name: str) -> Dict[str, Any]:
        self._load_if_needed()
        with self._lock:
            override = dict(self._items.get(name, {}))
        pinyin = str(override.get("pinyin") or "").strip().lower()
        return {
            "name": name,
            "pinyin": pinyin or self.auto_pinyin(name),
            "pinyin_source": "manual" if pinyin else "auto",
            "jyutping": str(override.get("jyutping") or "").strip().lower(),
            "audio_url": str(override.get("audio_url") or "").strip(),
            "note": str(override.get("note") or "").strip(),
        }

    def update(
        self,
        name: str,
        pinyin: Optional[str] = None,
        jyutping: Optional[str] = None,
        audio_url: Optional[str] = None,
        note: Optional[str] = None,
    ) -> Dict[str, Any]:
        clean_name = str(name or "").strip()
        if not clean_name:
            raise ValueError("站名不能为空")
        self._load_if_needed()
        with self._lock:
            item = dict(self._items.get(clean_name, {}))
            if pinyin is not None:
                item["pinyin"] = _SPACE_RE.sub(" ", pinyin.strip().lower())
            if jyutping is not None:
                item["jyutping"] = _SPACE_RE.sub(" ", jyutping.strip().lower())
            if audio_url is not None:
                item["audio_url"] = audio_url.strip()
            if note is not None:
                item["note"] = note.strip()
            if not any(str(value).strip() for value in item.values()):
                self._items.pop(clean_name, None)
            else:
                self._items[clean_name] = item
            self._save_locked()
        return self.get(clean_name)

    def export(self) -> Dict[str, Any]:
        self._load_if_needed()
        with self._lock:
            return {"version": 2, "stations": dict(sorted(self._items.items()))}

    def _save_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 2, "stations": dict(sorted(self._items.items()))}
        fd, temp_name = tempfile.mkstemp(
            prefix=self.path.name + ".", suffix=".tmp", dir=str(self.path.parent)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temp_name, self.path)
            self._mtime = self.path.stat().st_mtime
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
