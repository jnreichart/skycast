"""Archive NOAA's hourly forecast so it can be scored against the station later.

Every hour this fetches the National Weather Service hourly forecast for the
station's coordinates and records what was predicted for each of the next couple
of days, tagged with how far ahead the prediction was looking. Once the station
has measured those hours, the two can be compared.

Only the standard library is used, so there is nothing to install on the Pi.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

LOG = logging.getLogger("station.forecast")

API = "https://api.weather.gov"
# The NWS asks API clients to identify themselves. A browser can't set this
# header, but we can — it is the project, never anything about the person running it.
USER_AGENT = "skycast-station (https://github.com/jnreichart/skycast)"


def _get_json(url: str, timeout: float = 20.0) -> dict:
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/geo+json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def _epoch(iso: str) -> float:
    """NOAA timestamps carry an offset, e.g. 2026-11-18T21:00:00-07:00."""
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def _to_c(value, unit: str | None) -> float | None:
    if value is None:
        return None
    return (value - 32) * 5 / 9 if (unit or "F").upper().startswith("F") else float(value)


def _quantity(period: dict, key: str):
    q = period.get(key)
    return q.get("value") if isinstance(q, dict) else None


class ForecastArchiver(threading.Thread):
    """Polls the NWS hourly forecast and records it for later scoring."""

    daemon = True

    def __init__(self, store, lat: float, lon: float, interval: float = 3600.0, max_lead_hours: float = 48.0):
        super().__init__(name="forecast-archiver")
        self.store = store
        self.lat = lat
        self.lon = lon
        self.interval = interval
        self.max_lead_hours = max_lead_hours
        self.hourly_url: str | None = None
        self._point_fetched_at = 0.0
        self.last_success: float | None = None
        self.last_error: str | None = None
        self.runs = 0
        self._stop = threading.Event()

    def _resolve_point(self) -> str:
        """Grid metadata changes rarely; look it up once a day."""
        if self.hourly_url and time.time() - self._point_fetched_at < 86400:
            return self.hourly_url
        data = _get_json(f"{API}/points/{self.lat:.4f},{self.lon:.4f}")
        self.hourly_url = data["properties"]["forecastHourly"]
        self._point_fetched_at = time.time()
        LOG.info("forecast grid resolved: %s", data["properties"].get("gridId"))
        return self.hourly_url

    def fetch_once(self) -> int:
        """Fetch and store one forecast run. Returns the number of hours recorded."""
        fetched_ts = time.time()
        data = _get_json(self._resolve_point())
        props = data["properties"]
        issued_raw = props.get("updateTime") or props.get("generatedAt")
        issued_ts = _epoch(issued_raw) if issued_raw else None

        rows = []
        for period in props.get("periods", []):
            try:
                valid_ts = _epoch(period["startTime"])
            except (KeyError, ValueError):
                continue
            # Lead is measured from when we read the forecast, not from NOAA's
            # update time — see the schema comment in store.py.
            lead = (valid_ts - fetched_ts) / 3600.0
            if lead < 0 or lead > self.max_lead_hours:
                continue
            rows.append({
                "valid_ts": valid_ts,
                "fetched_ts": fetched_ts,
                "issued_ts": issued_ts,
                "lead_hours": round(lead, 3),
                "temp_c": _to_c(period.get("temperature"), period.get("temperatureUnit")),
                "humidity": _quantity(period, "relativeHumidity"),
                "pop": _quantity(period, "probabilityOfPrecipitation"),
                "short": period.get("shortForecast"),
            })

        stored = self.store.record_forecasts(rows)
        self.last_success = time.time()
        self.last_error = None
        self.runs += 1
        return stored

    def run(self) -> None:
        # Small initial delay so the first sensor reading lands before any network work.
        self._stop.wait(5)
        while not self._stop.is_set():
            started = time.time()
            try:
                stored = self.fetch_once()
                LOG.info("archived %d forecast hours", stored)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
                LOG.warning("forecast fetch failed: %s", exc)
            except Exception as exc:  # malformed payload shouldn't take the service down
                self.last_error = f"{type(exc).__name__}: {exc}"
                LOG.warning("forecast fetch failed: %s", exc, exc_info=True)
            self._stop.wait(max(60.0, self.interval - (time.time() - started)))

    def stop(self) -> None:
        self._stop.set()

    def status(self) -> dict:
        return {
            "enabled": True,
            "runs": self.runs,
            "last_success": self.last_success,
            "last_error": self.last_error,
            "max_lead_hours": self.max_lead_hours,
        }
