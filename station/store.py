"""SQLite storage for station readings: append, query history, derive trends."""
from __future__ import annotations

import sqlite3
import threading
import time
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    ts          REAL PRIMARY KEY,
    temp_c      REAL NOT NULL,
    humidity    REAL,
    pressure_pa REAL
);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);
"""


class Store:
    def __init__(self, path: str, retain_days: int = 400):
        self.path = path
        self.retain_days = retain_days
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.executescript(SCHEMA)
            # WAL keeps reads from blocking the sampler thread's writes.
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.commit()

    def add(self, reading) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO readings (ts, temp_c, humidity, pressure_pa) VALUES (?, ?, ?, ?)",
                (reading.timestamp, reading.temperature_c, reading.humidity, reading.pressure_pa),
            )
            self._db.commit()

    def latest(self) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM readings ORDER BY ts DESC LIMIT 1").fetchone()
        return dict(row) if row else None

    def history(self, hours: float = 24.0, max_points: int = 300) -> list[dict[str, Any]]:
        """Readings over the last `hours`, averaged into at most `max_points` buckets."""
        since = time.time() - hours * 3600
        bucket = max(1.0, (hours * 3600) / max_points)
        with self._lock:
            rows = self._db.execute(
                """
                SELECT CAST(ts / ? AS INTEGER) * ? AS bucket_ts,
                       AVG(temp_c)      AS temp_c,
                       AVG(humidity)    AS humidity,
                       AVG(pressure_pa) AS pressure_pa,
                       MIN(temp_c)      AS temp_min,
                       MAX(temp_c)      AS temp_max,
                       COUNT(*)         AS samples
                FROM readings
                WHERE ts >= ?
                GROUP BY bucket_ts
                ORDER BY bucket_ts
                """,
                (bucket, bucket, since),
            ).fetchall()
        return [
            {
                "ts": r["bucket_ts"],
                "temp_c": round(r["temp_c"], 2),
                "humidity": round(r["humidity"], 2) if r["humidity"] is not None else None,
                "pressure_pa": round(r["pressure_pa"], 1) if r["pressure_pa"] is not None else None,
                "temp_min": round(r["temp_min"], 2),
                "temp_max": round(r["temp_max"], 2),
                "samples": r["samples"],
            }
            for r in rows
        ]

    def extremes(self, hours: float = 24.0) -> dict[str, Any]:
        since = time.time() - hours * 3600
        with self._lock:
            row = self._db.execute(
                """
                SELECT MIN(temp_c) AS lo, MAX(temp_c) AS hi,
                       MIN(humidity) AS rh_lo, MAX(humidity) AS rh_hi, COUNT(*) AS n
                FROM readings WHERE ts >= ?
                """,
                (since,),
            ).fetchone()
            lo_row = self._db.execute(
                "SELECT ts FROM readings WHERE ts >= ? ORDER BY temp_c ASC LIMIT 1", (since,)
            ).fetchone()
            hi_row = self._db.execute(
                "SELECT ts FROM readings WHERE ts >= ? ORDER BY temp_c DESC LIMIT 1", (since,)
            ).fetchone()
        return {
            "temp_min_c": row["lo"],
            "temp_max_c": row["hi"],
            "temp_min_at": lo_row["ts"] if lo_row else None,
            "temp_max_at": hi_row["ts"] if hi_row else None,
            "humidity_min": row["rh_lo"],
            "humidity_max": row["rh_hi"],
            "samples": row["n"],
        }

    def pressure_trend_pa(self, hours: float = 3.0) -> float | None:
        """Pressure change over the last `hours` — the classic short-range forecast signal.

        Compares the newest reading with the one closest to `hours` ago, and only
        answers when that older reading is actually near the target time.
        """
        target = time.time() - hours * 3600
        with self._lock:
            now_row = self._db.execute(
                "SELECT ts, pressure_pa FROM readings WHERE pressure_pa IS NOT NULL ORDER BY ts DESC LIMIT 1"
            ).fetchone()
            then_row = self._db.execute(
                """
                SELECT ts, pressure_pa FROM readings
                WHERE pressure_pa IS NOT NULL
                ORDER BY ABS(ts - ?) ASC LIMIT 1
                """,
                (target,),
            ).fetchone()
        if not now_row or not then_row:
            return None
        # Don't report a "3-hour" trend from a gap of 30 minutes.
        if abs(then_row["ts"] - target) > 0.35 * hours * 3600:
            return None
        if now_row["ts"] - then_row["ts"] < 0.5 * hours * 3600:
            return None
        return round(now_row["pressure_pa"] - then_row["pressure_pa"], 1)

    def count(self) -> int:
        with self._lock:
            return self._db.execute("SELECT COUNT(*) AS n FROM readings").fetchone()["n"]

    def first_ts(self) -> float | None:
        with self._lock:
            row = self._db.execute("SELECT MIN(ts) AS t FROM readings").fetchone()
        return row["t"] if row else None

    def prune(self) -> int:
        """Drop readings past the retention window. Returns rows removed."""
        cutoff = time.time() - self.retain_days * 86400
        with self._lock:
            cur = self._db.execute("DELETE FROM readings WHERE ts < ?", (cutoff,))
            self._db.commit()
            return cur.rowcount

    def close(self) -> None:
        with self._lock:
            self._db.close()
