"""Bus candidate matching primitives.

The persistence layer still calls these functions directly while this module
provides the same explicit plugin surface as the metro implementation.
"""

from .db import normalize_stop, normalize_text, score_candidate, station_sequence_score, text_similarity

__all__ = [
    "normalize_stop",
    "normalize_text",
    "score_candidate",
    "station_sequence_score",
    "text_similarity",
]
