"""Metro candidate normalization and scoring."""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher
from typing import Any, Dict, List, Tuple


def normalize_name(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().casefold()
    text = re.sub(r"[\s·•・（）()【】\[\]_-]+", "", text)
    for token in ("深圳市", "深圳地铁", "地铁站", "地铁", "站"):
        text = text.replace(token, "")
    replacements = {
        "深圳北站": "深圳北",
        "机场北站": "机场北",
    }
    return replacements.get(text, text)


def similarity(a: str, b: str) -> float:
    left = normalize_name(a)
    right = normalize_name(b)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    if left in right or right in left:
        return 0.9
    return SequenceMatcher(None, left, right).ratio()


def _monotonic_pairs(official: List[str], candidate: List[str]) -> List[Tuple[int, int, float]]:
    pairs: List[Tuple[int, int, float]] = []
    cursor = 0
    for official_index, official_name in enumerate(official):
        best_index = -1
        best_score = 0.0
        for candidate_index in range(cursor, len(candidate)):
            score = similarity(official_name, candidate[candidate_index])
            if score > best_score:
                best_score = score
                best_index = candidate_index
            if score >= 0.98:
                break
        if best_index >= 0 and best_score >= 0.72:
            pairs.append((official_index, best_index, best_score))
            cursor = best_index + 1
    return pairs


def sequence_score(official: List[str], candidate: List[str]) -> float:
    if not official or not candidate:
        return 0.0
    pairs = _monotonic_pairs(official, candidate)
    if not pairs:
        return 0.0
    recall = len(pairs) / float(len(official))
    precision = len(pairs) / float(len(candidate))
    f1 = 2.0 * recall * precision / max(1e-9, recall + precision)
    average_similarity = sum(item[2] for item in pairs) / len(pairs)
    endpoint_bonus = 0.0
    if pairs[0][0] == 0 and pairs[0][1] <= 1:
        endpoint_bonus += 0.04
    if pairs[-1][0] == len(official) - 1 and pairs[-1][1] >= len(candidate) - 2:
        endpoint_bonus += 0.04
    return min(1.0, f1 * 0.82 + average_similarity * 0.18 + endpoint_bonus)


def endpoint_score(official: List[str], candidate: List[str]) -> float:
    if not official or not candidate:
        return 0.0
    return (similarity(official[0], candidate[0]) + similarity(official[-1], candidate[-1])) / 2.0


def line_name_score(official_name: str, candidate_name: str, aliases: List[str]) -> float:
    values = [official_name] + list(aliases or [])
    return max([similarity(value, candidate_name) for value in values] or [0.0])


def score_candidate(route: Dict[str, Any], candidate: Dict[str, Any]) -> Dict[str, Any]:
    official = [str(item) for item in route.get("stations", [])]
    candidate_stops = [str(item.get("name", "")) for item in candidate.get("via_stops", [])]
    forward_sequence = sequence_score(official, candidate_stops)
    reverse_sequence = sequence_score(official, list(reversed(candidate_stops)))
    reversed_path = reverse_sequence > forward_sequence
    oriented_stops = list(reversed(candidate_stops)) if reversed_path else candidate_stops
    sequence = max(forward_sequence, reverse_sequence)
    endpoints = endpoint_score(official, oriented_stops)
    name = line_name_score(str(route.get("name", "")), str(candidate.get("name", "")), route.get("aliases", []))
    total = sequence * 0.75 + endpoints * 0.15 + name * 0.10
    return {
        "total": round(total, 6),
        "sequence": round(sequence, 6),
        "endpoint": round(endpoints, 6),
        "name": round(name, 6),
        "reversed": reversed_path,
        "forward_sequence": round(forward_sequence, 6),
        "reverse_sequence": round(reverse_sequence, 6),
    }


def state_for_score(score: float) -> str:
    if score >= 0.90:
        return "matched"
    if score >= 0.75:
        return "review"
    return "failed"
