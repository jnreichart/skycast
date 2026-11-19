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

-- Every forecast read for a given hour, kept so it can be scored later against
-- what the station actually measured.
--
-- Rows are keyed on when we READ the forecast, not when NOAA issued it: NOAA's
-- grid update time can sit unchanged for hours, so keying on it would make
-- successive polls overwrite each other and the short lead times would never
-- fill up. lead_hours is therefore "how far ahead this prediction was looking
-- when it was read" — which is also the question a reader actually has.
CREATE TABLE IF NOT EXISTS forecasts (
    valid_ts   REAL NOT NULL,   -- start of the hour the forecast applies to
    fetched_ts REAL NOT NULL,   -- when the station read it
    issued_ts  REAL,            -- NOAA's own update time, for provenance
    lead_hours REAL NOT NULL,   -- valid_ts - fetched_ts, in hours
    temp_c     REAL,
    humidity   REAL,
    pop        REAL,
    short      TEXT,
    PRIMARY KEY (valid_ts, fetched_ts)
);
CREATE INDEX IF NOT EXISTS idx_forecasts_valid ON forecasts(valid_ts);
"""

# Lead times the accuracy report breaks out, in hours.
LEAD_BUCKETS = (1, 3, 6, 12, 24, 48)


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

    # ---------- archived forecasts, and scoring them ----------

    def record_forecasts(self, rows: list[dict[str, Any]]) -> int:
        """Store one NOAA forecast run. `rows` carry valid_ts, fetched_ts, lead_hours, temp_c…"""
        if not rows:
            return 0
        with self._lock:
            self._db.executemany(
                """
                INSERT OR REPLACE INTO forecasts
                    (valid_ts, fetched_ts, issued_ts, lead_hours, temp_c, humidity, pop, short)
                VALUES (:valid_ts, :fetched_ts, :issued_ts, :lead_hours, :temp_c, :humidity, :pop, :short)
                """,
                rows,
            )
            self._db.commit()
        return len(rows)

    def forecast_count(self) -> int:
        with self._lock:
            return self._db.execute("SELECT COUNT(*) AS n FROM forecasts").fetchone()["n"]

    def _accuracy_for_lead(self, lead: float, since: float, tolerance: float) -> dict[str, Any]:
        """Compare the forecast closest to `lead` hours ahead with the measured hour.

        For each hour there may be dozens of archived forecasts at different lead
        times; this picks the one nearest the bucket, then joins it to the hourly
        average of the station's own readings.
        """
        with self._lock:
            row = self._db.execute(
                """
                WITH actual AS (
                    SELECT CAST(ts / 3600 AS INTEGER) * 3600 AS hour_ts,
                           AVG(temp_c) AS actual_c,
                           COUNT(*)    AS n
                    FROM readings WHERE ts >= ?
                    GROUP BY hour_ts
                ),
                picked AS (
                    SELECT valid_ts, temp_c, lead_hours,
                           ROW_NUMBER() OVER (
                               PARTITION BY valid_ts ORDER BY ABS(lead_hours - ?)
                           ) AS rn
                    FROM forecasts
                    WHERE valid_ts >= ? AND ABS(lead_hours - ?) <= ? AND temp_c IS NOT NULL
                )
                SELECT COUNT(*)                            AS n,
                       AVG(p.temp_c - a.actual_c)          AS bias_c,
                       AVG(ABS(p.temp_c - a.actual_c))     AS mae_c,
                       MAX(ABS(p.temp_c - a.actual_c))     AS worst_c
                FROM picked p
                JOIN actual a ON a.hour_ts = p.valid_ts
                WHERE p.rn = 1 AND a.n >= 2
                """,
                (since, lead, since, lead, tolerance),
            ).fetchone()
        return {
            "lead_hours": lead,
            "hours_scored": row["n"] or 0,
            "bias_c": round(row["bias_c"], 2) if row["bias_c"] is not None else None,
            "mae_c": round(row["mae_c"], 2) if row["mae_c"] is not None else None,
            "worst_c": round(row["worst_c"], 2) if row["worst_c"] is not None else None,
        }

    def accuracy(self, days: float = 30.0) -> list[dict[str, Any]]:
        since = time.time() - days * 86400
        out = []
        for lead in LEAD_BUCKETS:
            tolerance = max(1.0, lead * 0.25)
            out.append(self._accuracy_for_lead(lead, since, tolerance))
        return out

    def paired_series(self, lead: float = 24.0, days: float = 3.0) -> list[dict[str, Any]]:
        """Forecast-vs-measured pairs for charting, at one lead time."""
        since = time.time() - days * 86400
        tolerance = max(1.0, lead * 0.25)
        with self._lock:
            rows = self._db.execute(
                """
                WITH actual AS (
                    SELECT CAST(ts / 3600 AS INTEGER) * 3600 AS hour_ts,
                           AVG(temp_c) AS actual_c, COUNT(*) AS n
                    FROM readings WHERE ts >= ?
                    GROUP BY hour_ts
                ),
                picked AS (
                    SELECT valid_ts, temp_c, lead_hours,
                           ROW_NUMBER() OVER (
                               PARTITION BY valid_ts ORDER BY ABS(lead_hours - ?)
                           ) AS rn
                    FROM forecasts
                    WHERE valid_ts >= ? AND ABS(lead_hours - ?) <= ? AND temp_c IS NOT NULL
                )
                SELECT p.valid_ts AS ts, p.temp_c AS forecast_c, a.actual_c, p.lead_hours
                FROM picked p
                JOIN actual a ON a.hour_ts = p.valid_ts
                WHERE p.rn = 1 AND a.n >= 2
                ORDER BY p.valid_ts
                """,
                (since, lead, since, lead, tolerance),
            ).fetchall()
        return [
            {
                "ts": r["ts"],
                "forecast_c": round(r["forecast_c"], 2),
                "actual_c": round(r["actual_c"], 2),
                "lead_hours": round(r["lead_hours"], 1),
            }
            for r in rows
        ]

    def prune(self) -> int:
        """Drop readings and archived forecasts past the retention window."""
        cutoff = time.time() - self.retain_days * 86400
        with self._lock:
            removed = self._db.execute("DELETE FROM readings WHERE ts < ?", (cutoff,)).rowcount
            removed += self._db.execute("DELETE FROM forecasts WHERE valid_ts < ?", (cutoff,)).rowcount
            self._db.commit()
            return removed

    def close(self) -> None:
        with self._lock:
            self._db.close()
