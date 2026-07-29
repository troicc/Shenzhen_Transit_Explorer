"""Reliable local Cantonese speech synthesis for the internal Learn edition.

Safari does not always expose every installed macOS voice through the Web
Speech API.  The internal server can still use the same installed voice via
``/usr/bin/say`` and return browser-playable PCM/WAV audio.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Optional


SAY_PATH = Path("/usr/bin/say")
_VOICE_LINE = re.compile(
    r"^(?P<name>.+?)\s+(?P<locale>(?:zh|yue)(?:[-_][A-Za-z0-9]+)+)\s+#",
    re.IGNORECASE,
)
_PREFERRED_NAMES = ("sinji", "kayan", "hoyin", "cantonese")


class CantoneseSpeechUnavailable(RuntimeError):
    """Raised when macOS cannot provide a genuine Cantonese voice."""


@dataclass(frozen=True)
class CantoneseAudio:
    content: bytes
    voice: str


def find_cantonese_voice(catalog: str) -> Optional[str]:
    """Return the best Cantonese voice from ``say -v ?`` output."""

    matches = []
    for line in catalog.splitlines():
        match = _VOICE_LINE.match(line.strip())
        if not match:
            continue
        locale = match.group("locale").replace("-", "_").casefold()
        if locale != "zh_hk" and not locale.startswith("yue_"):
            continue
        name = match.group("name").strip()
        folded = re.sub(r"[^a-z]", "", name.casefold())
        try:
            rank = _PREFERRED_NAMES.index(folded)
        except ValueError:
            rank = len(_PREFERRED_NAMES)
        matches.append((rank, name.casefold(), name))
    return min(matches)[2] if matches else None


@lru_cache(maxsize=1)
def cantonese_voice_name() -> str:
    if not SAY_PATH.is_file():
        raise CantoneseSpeechUnavailable("当前系统没有 macOS say 语音服务")
    try:
        result = subprocess.run(
            [str(SAY_PATH), "-v", "?"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise CantoneseSpeechUnavailable("无法读取 macOS 系统语音清单") from exc
    if result.returncode != 0:
        raise CantoneseSpeechUnavailable("macOS 系统语音清单读取失败")
    voice = find_cantonese_voice(result.stdout)
    if not voice:
        raise CantoneseSpeechUnavailable("macOS 未提供粤语（香港）系统声音")
    return voice


@lru_cache(maxsize=256)
def synthesize_cantonese(text: str) -> CantoneseAudio:
    """Synthesize short text with an installed Cantonese voice as PCM/WAV."""

    normalized = str(text).strip()
    if not normalized:
        raise ValueError("朗读文本不能为空")
    if len(normalized) > 120:
        raise ValueError("朗读文本不能超过 120 个字符")

    voice = cantonese_voice_name()
    with tempfile.NamedTemporaryFile(prefix="transit-cantonese-", suffix=".wav", delete=False) as handle:
        output_path = Path(handle.name)
    try:
        try:
            result = subprocess.run(
                [
                    str(SAY_PATH),
                    "-v",
                    voice,
                    "-r",
                    "155",
                    "-o",
                    str(output_path),
                    "--file-format=WAVE",
                    "--data-format=LEI16@22050",
                ],
                input=normalized,
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise CantoneseSpeechUnavailable("macOS 粤语合成服务调用失败") from exc
        if result.returncode != 0:
            raise CantoneseSpeechUnavailable("macOS 粤语声音无法完成合成")
        content = output_path.read_bytes()
        if len(content) < 44 or content[:4] != b"RIFF" or content[8:12] != b"WAVE":
            raise CantoneseSpeechUnavailable("macOS 粤语合成结果不是有效音频")
        return CantoneseAudio(content=content, voice=voice)
    finally:
        output_path.unlink(missing_ok=True)
