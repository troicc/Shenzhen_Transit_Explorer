from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import DB_PATH, NETWORK_PATH, OFFICIAL_PATH
from .matcher import score_candidate, state_for_score
from .official import ensure_official


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS official_routes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            short_name TEXT NOT NULL,
            color TEXT NOT NULL,
            aliases_json TEXT NOT NULL,
            stations_json TEXT NOT NULL,
            origin TEXT NOT NULL,
            destination TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            query_status TEXT NOT NULL DEFAULT 'pending',
            query_attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            selected_candidate_id INTEGER,
            match_score REAL,
            selected_reversed INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id TEXT NOT NULL,
            candidate_index INTEGER NOT NULL,
            query_alias TEXT,
            name TEXT,
            start_stop TEXT,
            end_stop TEXT,
            candidate_json TEXT NOT NULL,
            score REAL NOT NULL,
            score_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(route_id) REFERENCES official_routes(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_metro_candidates_route ON candidates(route_id);

        CREATE TABLE IF NOT EXISTS collection_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id TEXT,
            status TEXT NOT NULL,
            message TEXT,
            created_at TEXT NOT NULL
        );
        """
    )
    conn.commit()


def _route_fingerprint(route: Dict[str, Any]) -> str:
    return json.dumps(
        {
            "name": route.get("name"),
            "stations": route.get("stations", []),
            "aliases": route.get("aliases", []),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def load_official(payload: Optional[Dict[str, Any]] = None, db_path: Path = DB_PATH) -> Dict[str, Any]:
    payload = payload or ensure_official(OFFICIAL_PATH)
    routes = payload.get("routes", [])
    with connect(db_path) as conn:
        init_schema(conn)
        active_ids = []
        for route in routes:
            active_ids.append(route["id"])
            fingerprint = _route_fingerprint(route)
            existing = conn.execute("SELECT fingerprint FROM official_routes WHERE id=?", (route["id"],)).fetchone()
            changed = existing is not None and existing["fingerprint"] != fingerprint
            conn.execute(
                """
                INSERT INTO official_routes(
                    id,name,short_name,color,aliases_json,stations_json,origin,destination,
                    fingerprint,active,query_status,query_attempts,last_error,selected_candidate_id,
                    match_score,selected_reversed,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,1,'pending',0,NULL,NULL,NULL,0,?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,
                    short_name=excluded.short_name,
                    color=excluded.color,
                    aliases_json=excluded.aliases_json,
                    stations_json=excluded.stations_json,
                    origin=excluded.origin,
                    destination=excluded.destination,
                    fingerprint=excluded.fingerprint,
                    active=1,
                    query_status=CASE WHEN official_routes.fingerprint<>excluded.fingerprint THEN 'pending' ELSE official_routes.query_status END,
                    selected_candidate_id=CASE WHEN official_routes.fingerprint<>excluded.fingerprint THEN NULL ELSE official_routes.selected_candidate_id END,
                    match_score=CASE WHEN official_routes.fingerprint<>excluded.fingerprint THEN NULL ELSE official_routes.match_score END,
                    updated_at=excluded.updated_at
                """,
                (
                    route["id"], route["name"], route.get("short_name", route["name"]),
                    route.get("color", "#7da6c8"), json.dumps(route.get("aliases", []), ensure_ascii=False),
                    json.dumps(route.get("stations", []), ensure_ascii=False), route.get("origin", ""),
                    route.get("destination", ""), fingerprint, utcnow(),
                ),
            )
            if changed:
                conn.execute("DELETE FROM candidates WHERE route_id=?", (route["id"],))
        if active_ids:
            placeholders = ",".join("?" for _ in active_ids)
            conn.execute("UPDATE official_routes SET active=0 WHERE id NOT IN ({})".format(placeholders), active_ids)
        conn.commit()
    return {"routes": len(routes), "source_date": payload.get("source_date", "")}


def _row_to_route(row: sqlite3.Row) -> Dict[str, Any]:
    item = dict(row)
    item["aliases"] = json.loads(item.pop("aliases_json"))
    item["stations"] = json.loads(item.pop("stations_json"))
    item["selected_reversed"] = bool(item.get("selected_reversed"))
    return item


def get_stats(db_path: Path = DB_PATH) -> Dict[str, Any]:
    with connect(db_path) as conn:
        init_schema(conn)
        total = conn.execute("SELECT COUNT(*) AS n FROM official_routes WHERE active=1").fetchone()["n"]
        rows = conn.execute("SELECT query_status,COUNT(*) AS n FROM official_routes WHERE active=1 GROUP BY query_status").fetchall()
        source = ensure_official(OFFICIAL_PATH)
        return {
            "total_routes": total,
            "route_status": {row["query_status"]: row["n"] for row in rows},
            "source_date": source.get("source_date", ""),
            "source_url": source.get("source_url", ""),
            "network_exists": NETWORK_PATH.exists(),
            "network_size_bytes": NETWORK_PATH.stat().st_size if NETWORK_PATH.exists() else 0,
        }


def get_queue(limit: int = 20, retry: bool = False, db_path: Path = DB_PATH) -> List[Dict[str, Any]]:
    statuses = ["pending"]
    if retry:
        statuses.extend(["failed", "no_data", "error", "review"])
    placeholders = ",".join("?" for _ in statuses)
    with connect(db_path) as conn:
        init_schema(conn)
        rows = conn.execute(
            "SELECT * FROM official_routes WHERE active=1 AND query_status IN ({}) ORDER BY name LIMIT ?".format(placeholders),
            statuses + [limit],
        ).fetchall()
    return [_row_to_route(row) for row in rows]


def store_query_result(
    route_id: str,
    status: str,
    info: str,
    candidates: List[Dict[str, Any]],
    error: Optional[str] = None,
    db_path: Path = DB_PATH,
) -> Dict[str, Any]:
    with connect(db_path) as conn:
        init_schema(conn)
        row = conn.execute("SELECT * FROM official_routes WHERE id=?", (route_id,)).fetchone()
        if row is None:
            raise KeyError("地铁线路不存在：{}".format(route_id))
        route = _row_to_route(row)
        conn.execute("DELETE FROM candidates WHERE route_id=?", (route_id,))
        scored: List[Dict[str, Any]] = []
        for index, candidate in enumerate(candidates):
            score = score_candidate(route, candidate)
            cursor = conn.execute(
                """
                INSERT INTO candidates(route_id,candidate_index,query_alias,name,start_stop,end_stop,candidate_json,score,score_json,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    route_id, index, candidate.get("query_alias", ""), candidate.get("name", ""),
                    candidate.get("start_stop", ""), candidate.get("end_stop", ""),
                    json.dumps(candidate, ensure_ascii=False, separators=(",", ":")),
                    score["total"], json.dumps(score, ensure_ascii=False, separators=(",", ":")), utcnow(),
                ),
            )
            scored.append({"id": cursor.lastrowid, "index": index, "candidate": candidate, "score": score})

        selected_id = None
        selected_score = None
        selected_reversed = 0
        query_status = "error" if status == "error" else "no_data" if not scored else "failed"
        if scored:
            best = max(scored, key=lambda item: item["score"]["total"])
            selected_score = best["score"]["total"]
            query_status = state_for_score(selected_score)
            if query_status == "matched":
                selected_id = best["id"]
                selected_reversed = 1 if best["score"]["reversed"] else 0

        last_error = error or (None if scored else info or "没有高德候选")
        conn.execute(
            """
            UPDATE official_routes SET query_status=?,query_attempts=query_attempts+1,last_error=?,
            selected_candidate_id=?,match_score=?,selected_reversed=?,updated_at=? WHERE id=?
            """,
            (query_status, last_error, selected_id, selected_score, selected_reversed, utcnow(), route_id),
        )
        conn.execute(
            "INSERT INTO collection_log(route_id,status,message,created_at) VALUES(?,?,?,?)",
            (route_id, query_status, info or error or "", utcnow()),
        )
        conn.commit()
    return {
        "route_id": route_id,
        "query_status": query_status,
        "candidate_count": len(scored),
        "best_score": selected_score,
        "matches": [{"index": item["index"], **item["score"]} for item in scored],
    }


def get_review_list(limit: int = 100, db_path: Path = DB_PATH) -> List[Dict[str, Any]]:
    with connect(db_path) as conn:
        init_schema(conn)
        rows = conn.execute(
            "SELECT * FROM official_routes WHERE active=1 AND query_status IN ('review','failed','no_data','error') ORDER BY name LIMIT ?",
            (limit,),
        ).fetchall()
    return [_row_to_route(row) for row in rows]


def get_route_item(route_id: str, db_path: Path = DB_PATH) -> Dict[str, Any]:
    with connect(db_path) as conn:
        init_schema(conn)
        row = conn.execute("SELECT * FROM official_routes WHERE id=?", (route_id,)).fetchone()
        if row is None:
            raise KeyError("地铁线路不存在：{}".format(route_id))
        route = _row_to_route(row)
        candidate_rows = conn.execute("SELECT * FROM candidates WHERE route_id=? ORDER BY candidate_index", (route_id,)).fetchall()
    candidates = []
    for candidate_row in candidate_rows:
        candidates.append({
            "id": candidate_row["id"],
            "index": candidate_row["candidate_index"],
            "candidate": json.loads(candidate_row["candidate_json"]),
            "score": json.loads(candidate_row["score_json"]),
        })
    return {"route": route, "candidates": candidates}


def choose_candidate(route_id: str, candidate_id: int, reversed_path: Optional[bool] = None, db_path: Path = DB_PATH) -> Dict[str, Any]:
    with connect(db_path) as conn:
        init_schema(conn)
        row = conn.execute("SELECT * FROM candidates WHERE id=? AND route_id=?", (candidate_id, route_id)).fetchone()
        if row is None:
            raise KeyError("候选不存在")
        score = json.loads(row["score_json"])
        selected_reversed = bool(score.get("reversed")) if reversed_path is None else bool(reversed_path)
        conn.execute(
            "UPDATE official_routes SET selected_candidate_id=?,match_score=?,selected_reversed=?,query_status='matched',last_error=NULL,updated_at=? WHERE id=?",
            (candidate_id, float(score.get("total", 0.0)), 1 if selected_reversed else 0, utcnow(), route_id),
        )
        conn.commit()
    return {"route_id": route_id, "candidate_id": candidate_id, "reversed": selected_reversed, "query_status": "matched"}


def reset_routes(statuses: List[str], db_path: Path = DB_PATH) -> int:
    if not statuses:
        return 0
    placeholders = ",".join("?" for _ in statuses)
    with connect(db_path) as conn:
        init_schema(conn)
        cursor = conn.execute(
            "UPDATE official_routes SET query_status='pending',last_error=NULL,selected_candidate_id=NULL,match_score=NULL WHERE active=1 AND query_status IN ({})".format(placeholders),
            statuses,
        )
        conn.commit()
        return cursor.rowcount


def selected_routes(include_review: bool = False, db_path: Path = DB_PATH) -> List[Dict[str, Any]]:
    with connect(db_path) as conn:
        init_schema(conn)
        rows = conn.execute(
            """
            SELECT r.*,c.candidate_json,c.score_json
            FROM official_routes r
            JOIN candidates c ON c.id=r.selected_candidate_id
            WHERE r.active=1 AND r.selected_candidate_id IS NOT NULL
            ORDER BY r.name
            """
        ).fetchall()
    output = []
    for row in rows:
        route = _row_to_route(row)
        route["candidate"] = json.loads(row["candidate_json"])
        route["score_detail"] = json.loads(row["score_json"])
        output.append(route)
    return output


def initialize(db_path: Path = DB_PATH) -> Dict[str, Any]:
    payload = ensure_official(OFFICIAL_PATH)
    return load_official(payload, db_path)


def main() -> None:
    print(json.dumps(initialize(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
