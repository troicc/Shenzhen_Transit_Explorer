from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
import zlib
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from .config import CATALOG_PATH, DB_PATH, NETWORK_PATH


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS official_routes (
            id INTEGER PRIMARY KEY,
            route_no TEXT NOT NULL,
            operator TEXT NOT NULL,
            start_stop TEXT,
            end_stop TEXT,
            directions_json TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            query_status TEXT NOT NULL DEFAULT 'pending',
            query_attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_official_routes_status
            ON official_routes(query_status, id);
        CREATE INDEX IF NOT EXISTS idx_official_routes_no
            ON official_routes(route_no);

        CREATE TABLE IF NOT EXISTS query_results (
            route_id INTEGER PRIMARY KEY REFERENCES official_routes(id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            info TEXT,
            candidates_blob BLOB,
            queried_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS direction_matches (
            route_id INTEGER NOT NULL REFERENCES official_routes(id) ON DELETE CASCADE,
            direction TEXT NOT NULL,
            candidate_index INTEGER,
            score REAL NOT NULL DEFAULT 0,
            match_state TEXT NOT NULL,
            candidate_name TEXT,
            candidate_start TEXT,
            candidate_end TEXT,
            candidate_blob BLOB,
            auto_selected INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(route_id, direction)
        );

        CREATE INDEX IF NOT EXISTS idx_direction_matches_state
            ON direction_matches(match_state, route_id);

        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )


def load_catalog(catalog_path: Path = CATALOG_PATH, db_path: Path = DB_PATH) -> Dict[str, Any]:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    routes = catalog.get("routes", [])
    conn = connect(db_path)
    init_schema(conn)
    now = utcnow()

    incoming_ids: Set[int] = set()
    changed = 0
    added = 0
    preserved = 0

    for route in routes:
        route_id = int(route["id"])
        incoming_ids.add(route_id)
        existing = conn.execute(
            "SELECT fingerprint FROM official_routes WHERE id=?", (route_id,)
        ).fetchone()
        directions_json = json.dumps(route.get("directions", []), ensure_ascii=False)
        if existing is None:
            conn.execute(
                """
                INSERT INTO official_routes(
                    id, route_no, operator, start_stop, end_stop,
                    directions_json, fingerprint, active, query_status,
                    query_attempts, updated_at
                ) VALUES(?,?,?,?,?,?,?,1,'pending',0,?)
                """,
                (
                    route_id,
                    str(route.get("route_no", "")),
                    str(route.get("operator", "")),
                    str(route.get("start_stop", "")),
                    str(route.get("end_stop", "")),
                    directions_json,
                    str(route.get("fingerprint", "")),
                    now,
                ),
            )
            added += 1
        elif existing["fingerprint"] != route.get("fingerprint", ""):
            conn.execute(
                """
                UPDATE official_routes SET
                    route_no=?, operator=?, start_stop=?, end_stop=?,
                    directions_json=?, fingerprint=?, active=1,
                    query_status='pending', query_attempts=0,
                    last_error=NULL, updated_at=?
                WHERE id=?
                """,
                (
                    str(route.get("route_no", "")),
                    str(route.get("operator", "")),
                    str(route.get("start_stop", "")),
                    str(route.get("end_stop", "")),
                    directions_json,
                    str(route.get("fingerprint", "")),
                    now,
                    route_id,
                ),
            )
            conn.execute("DELETE FROM query_results WHERE route_id=?", (route_id,))
            conn.execute("DELETE FROM direction_matches WHERE route_id=?", (route_id,))
            changed += 1
        else:
            conn.execute(
                """
                UPDATE official_routes SET
                    route_no=?, operator=?, start_stop=?, end_stop=?,
                    directions_json=?, active=1, updated_at=?
                WHERE id=?
                """,
                (
                    str(route.get("route_no", "")),
                    str(route.get("operator", "")),
                    str(route.get("start_stop", "")),
                    str(route.get("end_stop", "")),
                    directions_json,
                    now,
                    route_id,
                ),
            )
            preserved += 1

    if incoming_ids:
        placeholders = ",".join("?" for _ in incoming_ids)
        conn.execute(
            f"UPDATE official_routes SET active=0 WHERE id NOT IN ({placeholders})",
            tuple(sorted(incoming_ids)),
        )

    meta = {
        "source_title": catalog.get("source_title", ""),
        "source_date": catalog.get("source_date", ""),
        "published_at": catalog.get("published_at", ""),
        "route_count": len(routes),
        "loaded_at": now,
    }
    conn.execute(
        "INSERT INTO app_meta(key,value) VALUES('catalog_meta',?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (json.dumps(meta, ensure_ascii=False),),
    )
    conn.commit()
    conn.close()
    return {"added": added, "changed": changed, "preserved": preserved, **meta}


_PLATFORM_MARKS = re.compile(r"[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳⓪❶❷❸❹❺❻❼❽❾❿]")
_NON_WORD = re.compile(r"[\s\-—_·•,，.。;；:：()（）\[\]【】/\\]+")


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).upper().strip()
    text = _NON_WORD.sub("", text)
    return text


def normalize_stop(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    text = _PLATFORM_MARKS.sub("", text)
    text = _NON_WORD.sub("", text)
    return text


def text_similarity(a: Any, b: Any, stop: bool = False) -> float:
    na = normalize_stop(a) if stop else normalize_text(a)
    nb = normalize_stop(b) if stop else normalize_text(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na in nb or nb in na:
        shorter = min(len(na), len(nb))
        longer = max(len(na), len(nb))
        return max(0.82, shorter / max(1, longer))
    return SequenceMatcher(None, na, nb).ratio()


def _candidate_stops(candidate: Dict[str, Any]) -> List[str]:
    stops = candidate.get("via_stops") or []
    return [str(item.get("name", "")) for item in stops if item.get("name")]


def station_sequence_score(official: List[str], candidate: List[str]) -> float:
    if not official or not candidate:
        return 0.0
    used: Set[int] = set()
    pairs: List[Tuple[int, int]] = []
    for oi, off_name in enumerate(official):
        best_index = -1
        best_score = 0.0
        for ci, cand_name in enumerate(candidate):
            if ci in used:
                continue
            score = text_similarity(off_name, cand_name, stop=True)
            if score > best_score:
                best_score = score
                best_index = ci
        if best_index >= 0 and best_score >= 0.72:
            used.add(best_index)
            pairs.append((oi, best_index))

    if not pairs:
        return 0.0
    recall = len(pairs) / len(official)
    precision = len(pairs) / len(candidate)
    candidate_positions = [ci for _, ci in sorted(pairs)]
    lis: List[int] = []
    for value in candidate_positions:
        lo, hi = 0, len(lis)
        while lo < hi:
            mid = (lo + hi) // 2
            if lis[mid] < value:
                lo = mid + 1
            else:
                hi = mid
        if lo == len(lis):
            lis.append(value)
        else:
            lis[lo] = value
    order = len(lis) / len(pairs)
    return (0.72 * recall + 0.28 * precision) * (0.55 + 0.45 * order)


def score_candidate(
    route_no: str,
    direction: Dict[str, Any],
    candidate: Dict[str, Any],
) -> Dict[str, float]:
    candidate_stops = _candidate_stops(candidate)
    cand_start = candidate.get("start_stop") or (candidate_stops[0] if candidate_stops else "")
    cand_end = candidate.get("end_stop") or (candidate_stops[-1] if candidate_stops else "")
    off_start = direction.get("start_stop") or (direction.get("stops") or [""])[0]
    off_end = direction.get("end_stop") or (direction.get("stops") or [""])[-1]

    endpoint = (
        text_similarity(off_start, cand_start, stop=True)
        + text_similarity(off_end, cand_end, stop=True)
    ) / 2
    stations = station_sequence_score(direction.get("stops") or [], candidate_stops)
    route_norm = normalize_text(route_no).removesuffix("路")
    candidate_name = normalize_text(candidate.get("name", ""))
    route_match = 1.0 if route_norm and route_norm in candidate_name else text_similarity(route_no, candidate.get("name", ""))
    total = 0.45 * endpoint + 0.40 * stations + 0.15 * route_match
    return {
        "total": round(total, 6),
        "endpoint": round(endpoint, 6),
        "stations": round(stations, 6),
        "route": round(route_match, 6),
    }


def _compress_json(value: Any) -> bytes:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return zlib.compress(raw, 6)


def _decompress_json(blob: Optional[bytes], default: Any = None) -> Any:
    if not blob:
        return default
    return json.loads(zlib.decompress(blob).decode("utf-8"))


def _clean_candidates(candidates: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cleaned: List[Dict[str, Any]] = []
    for candidate in candidates:
        path = []
        for point in candidate.get("path") or []:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            try:
                lng, lat = float(point[0]), float(point[1])
            except (TypeError, ValueError):
                continue
            if 70 <= lng <= 140 and 0 <= lat <= 60:
                path.append([round(lng, 7), round(lat, 7)])
        via_stops = []
        for stop in candidate.get("via_stops") or []:
            loc = stop.get("location") or []
            if not isinstance(loc, (list, tuple)) or len(loc) < 2:
                continue
            try:
                lng, lat = float(loc[0]), float(loc[1])
            except (TypeError, ValueError):
                continue
            via_stops.append(
                {
                    "id": str(stop.get("id", "")),
                    "name": str(stop.get("name", "")),
                    "location": [round(lng, 7), round(lat, 7)],
                }
            )
        if not path and len(via_stops) >= 2:
            path = [item["location"] for item in via_stops]
        cleaned.append(
            {
                "id": str(candidate.get("id", "")),
                "name": str(candidate.get("name", "")),
                "start_stop": str(candidate.get("start_stop", "")),
                "end_stop": str(candidate.get("end_stop", "")),
                "company": str(candidate.get("company", "")),
                "type": str(candidate.get("type", "")),
                "distance": candidate.get("distance"),
                "path": path,
                "via_stops": via_stops,
            }
        )
    return cleaned


def store_query_result(
    route_id: int,
    status: str,
    info: str,
    candidates: List[Dict[str, Any]],
    error: Optional[str] = None,
    db_path: Path = DB_PATH,
) -> Dict[str, Any]:
    conn = connect(db_path)
    init_schema(conn)
    route = conn.execute("SELECT * FROM official_routes WHERE id=?", (route_id,)).fetchone()
    if route is None:
        conn.close()
        raise KeyError(f"未知线路 id={route_id}")

    now = utcnow()
    clean = _clean_candidates(candidates)
    directions = json.loads(route["directions_json"])
    conn.execute(
        """
        INSERT INTO query_results(route_id,status,info,candidates_blob,queried_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(route_id) DO UPDATE SET
          status=excluded.status, info=excluded.info,
          candidates_blob=excluded.candidates_blob, queried_at=excluded.queried_at
        """,
        (route_id, status, info, _compress_json(clean), now),
    )

    summary: List[Dict[str, Any]] = []
    if status == "complete" and clean:
        states: List[str] = []
        for direction in directions:
            scored = []
            for idx, candidate in enumerate(clean):
                parts = score_candidate(route["route_no"], direction, candidate)
                scored.append((parts["total"], idx, parts, candidate))
            scored.sort(key=lambda item: item[0], reverse=True)
            best_score, best_idx, parts, best = scored[0]
            if not best.get("path"):
                match_state = "failed"
            elif best_score >= 0.58:
                match_state = "matched"
            elif best_score >= 0.34:
                match_state = "review"
            else:
                match_state = "failed"
            states.append(match_state)
            conn.execute(
                """
                INSERT INTO direction_matches(
                    route_id,direction,candidate_index,score,match_state,
                    candidate_name,candidate_start,candidate_end,candidate_blob,
                    auto_selected,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,1,?)
                ON CONFLICT(route_id,direction) DO UPDATE SET
                  candidate_index=excluded.candidate_index,
                  score=excluded.score,
                  match_state=excluded.match_state,
                  candidate_name=excluded.candidate_name,
                  candidate_start=excluded.candidate_start,
                  candidate_end=excluded.candidate_end,
                  candidate_blob=excluded.candidate_blob,
                  auto_selected=1,updated_at=excluded.updated_at
                """,
                (
                    route_id,
                    direction["direction"],
                    best_idx,
                    best_score,
                    match_state,
                    best.get("name", ""),
                    best.get("start_stop", ""),
                    best.get("end_stop", ""),
                    _compress_json(best),
                    now,
                ),
            )
            summary.append(
                {
                    "direction": direction["direction"],
                    "candidate_index": best_idx,
                    "candidate_name": best.get("name", ""),
                    "score": best_score,
                    "state": match_state,
                    "parts": parts,
                }
            )
        if states and all(item == "matched" for item in states):
            query_status = "matched"
        elif states and any(item in {"matched", "review"} for item in states):
            query_status = "review"
        else:
            query_status = "failed"
        last_error = None
    elif status == "no_data":
        query_status = "no_data"
        last_error = error or info or "无结果"
        conn.execute("DELETE FROM direction_matches WHERE route_id=?", (route_id,))
    else:
        query_status = "error"
        last_error = error or info or status

    conn.execute(
        """
        UPDATE official_routes SET
          query_status=?, query_attempts=query_attempts+1,
          last_error=?, updated_at=? WHERE id=?
        """,
        (query_status, last_error, now, route_id),
    )
    conn.commit()
    conn.close()
    return {"route_id": route_id, "query_status": query_status, "matches": summary}


def choose_candidate(
    route_id: int,
    direction_name: str,
    candidate_index: int,
    db_path: Path = DB_PATH,
) -> Dict[str, Any]:
    conn = connect(db_path)
    route = conn.execute("SELECT * FROM official_routes WHERE id=?", (route_id,)).fetchone()
    result = conn.execute("SELECT candidates_blob FROM query_results WHERE route_id=?", (route_id,)).fetchone()
    if route is None or result is None:
        conn.close()
        raise KeyError("线路或候选结果不存在")
    candidates = _decompress_json(result["candidates_blob"], [])
    if candidate_index < 0 or candidate_index >= len(candidates):
        conn.close()
        raise IndexError("候选序号越界")
    directions = json.loads(route["directions_json"])
    direction = next((d for d in directions if d["direction"] == direction_name), None)
    if direction is None:
        conn.close()
        raise KeyError("方向不存在")
    candidate = candidates[candidate_index]
    parts = score_candidate(route["route_no"], direction, candidate)
    now = utcnow()
    conn.execute(
        """
        INSERT INTO direction_matches(
          route_id,direction,candidate_index,score,match_state,
          candidate_name,candidate_start,candidate_end,candidate_blob,
          auto_selected,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,0,?)
        ON CONFLICT(route_id,direction) DO UPDATE SET
          candidate_index=excluded.candidate_index,score=excluded.score,
          match_state='matched',candidate_name=excluded.candidate_name,
          candidate_start=excluded.candidate_start,candidate_end=excluded.candidate_end,
          candidate_blob=excluded.candidate_blob,auto_selected=0,
          updated_at=excluded.updated_at
        """,
        (
            route_id,
            direction_name,
            candidate_index,
            parts["total"],
            "matched",
            candidate.get("name", ""),
            candidate.get("start_stop", ""),
            candidate.get("end_stop", ""),
            _compress_json(candidate),
            now,
        ),
    )
    states = [
        row[0]
        for row in conn.execute(
            "SELECT match_state FROM direction_matches WHERE route_id=?", (route_id,)
        ).fetchall()
    ]
    expected = len(directions)
    status = "matched" if len(states) == expected and all(x == "matched" for x in states) else "review"
    conn.execute(
        "UPDATE official_routes SET query_status=?,updated_at=? WHERE id=?",
        (status, now, route_id),
    )
    conn.commit()
    conn.close()
    return {"route_id": route_id, "direction": direction_name, "candidate_index": candidate_index, "score": parts}


def reset_routes(statuses: Iterable[str], db_path: Path = DB_PATH) -> int:
    statuses = list(statuses)
    if not statuses:
        return 0
    conn = connect(db_path)
    placeholders = ",".join("?" for _ in statuses)
    rows = conn.execute(
        f"SELECT id FROM official_routes WHERE query_status IN ({placeholders}) AND active=1",
        tuple(statuses),
    ).fetchall()
    ids = [row[0] for row in rows]
    if ids:
        id_marks = ",".join("?" for _ in ids)
        conn.execute(
            f"UPDATE official_routes SET query_status='pending',last_error=NULL WHERE id IN ({id_marks})",
            tuple(ids),
        )
    conn.commit()
    conn.close()
    return len(ids)


def get_catalog_meta(conn: sqlite3.Connection) -> Dict[str, Any]:
    row = conn.execute("SELECT value FROM app_meta WHERE key='catalog_meta'").fetchone()
    return json.loads(row["value"]) if row else {}


def get_stats(db_path: Path = DB_PATH) -> Dict[str, Any]:
    conn = connect(db_path)
    init_schema(conn)
    rows = conn.execute(
        "SELECT query_status,COUNT(*) AS n FROM official_routes WHERE active=1 GROUP BY query_status"
    ).fetchall()
    directions = conn.execute(
        "SELECT match_state,COUNT(*) AS n FROM direction_matches GROUP BY match_state"
    ).fetchall()
    total = conn.execute("SELECT COUNT(*) FROM official_routes WHERE active=1").fetchone()[0]
    result = {
        "total_routes": total,
        "route_status": {row["query_status"]: row["n"] for row in rows},
        "direction_status": {row["match_state"]: row["n"] for row in directions},
        "catalog": get_catalog_meta(conn),
        "network_exists": NETWORK_PATH.exists(),
    }
    conn.close()
    return result


def get_queue(limit: int = 20, include_retry: bool = False, db_path: Path = DB_PATH) -> List[Dict[str, Any]]:
    conn = connect(db_path)
    statuses = ["pending"]
    if include_retry:
        statuses.extend(["error", "no_data", "failed"])
    marks = ",".join("?" for _ in statuses)
    rows = conn.execute(
        f"""
        SELECT id,route_no,operator,start_stop,end_stop,directions_json,
               query_status,query_attempts,last_error
        FROM official_routes
        WHERE active=1 AND query_status IN ({marks})
        ORDER BY CASE query_status WHEN 'pending' THEN 0 ELSE 1 END,
                 query_attempts,id
        LIMIT ?
        """,
        (*statuses, max(1, min(limit, 200))),
    ).fetchall()
    conn.close()
    return [
        {
            **{key: row[key] for key in row.keys() if key != "directions_json"},
            "directions": json.loads(row["directions_json"]),
        }
        for row in rows
    ]


def get_review_list(limit: int = 100, db_path: Path = DB_PATH) -> List[Dict[str, Any]]:
    conn = connect(db_path)
    rows = conn.execute(
        """
        SELECT id,route_no,operator,start_stop,end_stop,query_status,last_error
        FROM official_routes
        WHERE active=1 AND query_status IN ('review','failed','no_data','error')
        ORDER BY CASE query_status WHEN 'review' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,id
        LIMIT ?
        """,
        (max(1, min(limit, 500)),),
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_route_item(route_id: int, db_path: Path = DB_PATH) -> Dict[str, Any]:
    conn = connect(db_path)
    route = conn.execute("SELECT * FROM official_routes WHERE id=?", (route_id,)).fetchone()
    if route is None:
        conn.close()
        raise KeyError("线路不存在")
    result = conn.execute("SELECT * FROM query_results WHERE route_id=?", (route_id,)).fetchone()
    matches = conn.execute(
        "SELECT * FROM direction_matches WHERE route_id=? ORDER BY direction", (route_id,)
    ).fetchall()
    directions = json.loads(route["directions_json"])
    candidates = _decompress_json(result["candidates_blob"], []) if result else []
    candidate_scores: Dict[str, List[Dict[str, Any]]] = {}
    for direction in directions:
        candidate_scores[direction["direction"]] = [
            {
                "index": idx,
                "score": score_candidate(route["route_no"], direction, candidate),
            }
            for idx, candidate in enumerate(candidates)
        ]
    payload = {
        "route": {
            "id": route["id"],
            "route_no": route["route_no"],
            "operator": route["operator"],
            "start_stop": route["start_stop"],
            "end_stop": route["end_stop"],
            "directions": directions,
            "query_status": route["query_status"],
            "query_attempts": route["query_attempts"],
            "last_error": route["last_error"],
        },
        "query": dict(result) if result else None,
        "candidates": candidates,
        "candidate_scores": candidate_scores,
        "matches": [
            {
                key: row[key]
                for key in row.keys()
                if key not in {"candidate_blob"}
            }
            for row in matches
        ],
    }
    if payload["query"]:
        payload["query"].pop("candidates_blob", None)
    conn.close()
    return payload


def iter_direction_matches(db_path: Path = DB_PATH, include_review: bool = True):
    conn = connect(db_path)
    states = ("matched", "review") if include_review else ("matched",)
    marks = ",".join("?" for _ in states)
    rows = conn.execute(
        f"""
        SELECT r.id AS route_id,r.route_no,r.operator,r.start_stop AS route_start,
               r.end_stop AS route_end,r.directions_json,r.fingerprint,
               m.direction,m.score,m.match_state,m.candidate_name,
               m.candidate_start,m.candidate_end,m.candidate_blob,m.auto_selected
        FROM direction_matches m
        JOIN official_routes r ON r.id=m.route_id
        WHERE r.active=1 AND m.match_state IN ({marks}) AND m.candidate_blob IS NOT NULL
        ORDER BY r.id,m.direction
        """,
        states,
    ).fetchall()
    for row in rows:
        directions = json.loads(row["directions_json"])
        official_direction = next(
            (item for item in directions if item["direction"] == row["direction"]), None
        )
        if official_direction is None:
            continue
        yield {
            "route_id": row["route_id"],
            "route_no": row["route_no"],
            "operator": row["operator"],
            "route_start": row["route_start"],
            "route_end": row["route_end"],
            "fingerprint": row["fingerprint"],
            "direction": row["direction"],
            "score": row["score"],
            "match_state": row["match_state"],
            "auto_selected": bool(row["auto_selected"]),
            "official": official_direction,
            "candidate": _decompress_json(row["candidate_blob"], {}),
        }
    conn.close()
