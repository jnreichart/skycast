#!/usr/bin/env python3
"""Skycast home weather station.

Samples a BME280 on a Raspberry Pi, stores readings in SQLite, and serves both a
JSON API and the Skycast web app over HTTP on your LAN.

Serving the app from the same origin as the API is deliberate: a page loaded over
HTTPS (like the GitHub Pages copy) is not allowed to read a plain-HTTP endpoint on
your network, so the station would be invisible to it. Same box, same origin, no
mixed content.

    python3 server.py --mock                 # develop with no hardware
    python3 server.py --altitude 1624        # real sensor, metres above sea level
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import socket
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from bme280 import open_sensor
from forecast import ForecastArchiver
from store import Store

LOG = logging.getLogger("station")
APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Sampler(threading.Thread):
    """Reads the sensor on a fixed interval and appends to the store."""

    daemon = True

    def __init__(self, sensor, store: Store, interval: float):
        super().__init__(name="sampler")
        self.sensor = sensor
        self.store = store
        self.interval = interval
        self.started_at = time.time()
        self.last_error: str | None = None
        self.consecutive_errors = 0
        self.total_reads = 0
        self._stop = threading.Event()

    def run(self) -> None:
        next_prune = time.time() + 3600
        while not self._stop.is_set():
            cycle_start = time.time()
            try:
                reading = self.sensor.read()
                self.store.add(reading)
                self.total_reads += 1
                self.consecutive_errors = 0
                self.last_error = None
            except Exception as exc:  # a flaky I2C line shouldn't kill the service
                self.consecutive_errors += 1
                self.last_error = f"{type(exc).__name__}: {exc}"
                LOG.warning("sensor read failed (%d in a row): %s", self.consecutive_errors, exc)

            if time.time() > next_prune:
                try:
                    removed = self.store.prune()
                    if removed:
                        LOG.info("pruned %d old readings", removed)
                except Exception as exc:
                    LOG.warning("prune failed: %s", exc)
                next_prune = time.time() + 3600

            self._stop.wait(max(0.5, self.interval - (time.time() - cycle_start)))

    def stop(self) -> None:
        self._stop.set()

    @property
    def healthy(self) -> bool:
        return self.consecutive_errors < 5


class StationHandler(SimpleHTTPRequestHandler):
    """Serves /api/* from the sampler and store; everything else is the web app."""

    sampler: Sampler
    store: Store
    config: dict
    archiver: ForecastArchiver | None = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_ROOT, **kwargs)

    # --- helpers -------------------------------------------------------
    def _send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _current_payload(self) -> dict:
        latest = self.store.latest()
        if not latest:
            return {"station": self.config, "available": False, "reason": "no readings yet"}

        from bme280 import Reading  # local import keeps the module import graph flat

        reading = Reading(
            temperature_c=latest["temp_c"],
            humidity=latest["humidity"],
            pressure_pa=latest["pressure_pa"],
            timestamp=latest["ts"],
        )
        altitude = self.config.get("altitude_m") or 0.0
        sea_level = reading.sea_level_pressure_pa(altitude)
        return {
            "station": self.config,
            "available": True,
            "observed_at": reading.timestamp,
            "age_seconds": round(time.time() - reading.timestamp, 1),
            "temperature_c": reading.temperature_c,
            "humidity": reading.humidity,
            "dewpoint_c": round(reading.dewpoint_c, 2) if reading.dewpoint_c is not None else None,
            "pressure_pa": reading.pressure_pa,
            "sea_level_pressure_pa": round(sea_level, 1) if sea_level is not None else None,
            "pressure_trend_3h_pa": self.store.pressure_trend_pa(3.0),
            "last_24h": self.store.extremes(24.0),
            "samples": self.store.count(),
            "since": self.store.first_ts(),
        }

    # --- routing -------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        route = urlparse(self.path)
        path = route.path.rstrip("/") or "/"

        if path == "/api/health":
            self._send_json({
                "ok": self.sampler.healthy,
                "service": "skycast-station",
                "sensor": self.config.get("sensor"),
                "uptime_seconds": round(time.time() - self.sampler.started_at, 1),
                "reads": self.sampler.total_reads,
                "consecutive_errors": self.sampler.consecutive_errors,
                "last_error": self.sampler.last_error,
                "forecast_archive": self.archiver.status() if self.archiver else {"enabled": False},
            })
            return

        if path == "/api/accuracy":
            params = parse_qs(route.query)
            try:
                days = min(400.0, max(1.0, float(params.get("days", ["30"])[0])))
                lead = min(48.0, max(1.0, float(params.get("lead", ["24"])[0])))
                series_days = min(14.0, max(1.0, float(params.get("series_days", ["3"])[0])))
            except ValueError:
                self._send_json({"error": "days, lead and series_days must be numbers"}, 400)
                return
            archived = self.store.forecast_count()
            self._send_json({
                # Scores are worth showing whenever an archive exists, even if
                # archiving has since been turned off.
                "enabled": self.archiver is not None or archived > 0,
                "archiving": self.archiver is not None,
                "days": days,
                "by_lead": self.store.accuracy(days),
                "series": {
                    "lead_hours": lead,
                    "days": series_days,
                    "points": self.store.paired_series(lead, series_days),
                },
                "forecasts_archived": archived,
            })
            return

        if path == "/api/current":
            self._send_json(self._current_payload())
            return

        if path == "/api/history":
            params = parse_qs(route.query)
            try:
                hours = min(24 * 90, max(0.25, float(params.get("hours", ["24"])[0])))
                max_points = min(2000, max(10, int(params.get("points", ["300"])[0])))
            except ValueError:
                self._send_json({"error": "hours and points must be numbers"}, 400)
                return
            self._send_json({
                "station": self.config,
                "hours": hours,
                "points": self.store.history(hours, max_points),
            })
            return

        if path.startswith("/api/"):
            self._send_json({"error": f"no such endpoint: {route.path}"}, 404)
            return

        super().do_GET()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def end_headers(self) -> None:
        # The app's own files change when you git pull; don't let browsers hold stale JS.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        LOG.debug("%s - %s", self.address_string(), fmt % args)


def seed_history(store: Store, hours: float, altitude_m: float = 0.0, step_seconds: float = 300.0) -> int:
    """Dev helper: backfill plausible past readings so charts have something to draw."""
    from bme280 import MockBME280

    mock = MockBME280(altitude_m=altitude_m)
    now = time.time()
    count = 0
    for i in range(int(hours * 3600 / step_seconds), 0, -1):
        store.add(mock.read(at=now - i * step_seconds))
        count += 1
    return count


def seed_forecasts(store: Store, hours: float) -> int:
    """Dev helper: invent past forecasts for the hours already in the store.

    Each is the measured value plus a bias and noise that both grow with lead
    time, which is roughly how real forecasts behave — so the accuracy report has
    something meaningful to show before any real archiving has happened.
    """
    import random

    from store import LEAD_BUCKETS

    actuals = store.history(hours=hours, max_points=2000)
    rows = []
    for point in actuals:
        hour_ts = int(point["ts"] // 3600) * 3600
        for lead in LEAD_BUCKETS:
            bias = 0.3 + lead * 0.03
            noise = random.gauss(0.0, 0.4 + lead * 0.045)
            rows.append({
                "valid_ts": float(hour_ts),
                "fetched_ts": float(hour_ts - lead * 3600),
                "issued_ts": float(hour_ts - lead * 3600),
                "lead_hours": float(lead),
                "temp_c": round(point["temp_c"] + bias + noise, 2),
                "humidity": point["humidity"],
                "pop": 0,
                "short": "Simulated forecast",
            })
    return store.record_forecasts(rows)


def local_ip() -> str:
    """Best-effort LAN address, for printing a URL you can open from another device."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no packets are sent; this just picks the route
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Skycast home weather station")
    ap.add_argument("--port", type=int, default=8000, help="HTTP port (default 8000)")
    ap.add_argument("--host", default="0.0.0.0", help="bind address (default all interfaces)")
    ap.add_argument("--interval", type=float, default=30.0, help="seconds between samples (default 30)")
    ap.add_argument("--altitude", type=float, default=0.0, help="station altitude in metres, for sea-level pressure")
    ap.add_argument("--name", default="Home station", help="display name shown in the app")
    ap.add_argument("--lat", type=float, default=None, help="latitude; lets the app open on your location with no setup")
    ap.add_argument("--lon", type=float, default=None, help="longitude; pair with --lat")
    ap.add_argument("--db", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "station.db"))
    ap.add_argument("--bus", type=int, default=1, help="I2C bus number (default 1)")
    ap.add_argument("--address", default="0x76", help="I2C address, 0x76 or 0x77 (default 0x76)")
    ap.add_argument("--retain-days", type=int, default=400)
    ap.add_argument("--mock", action="store_true", help="fake readings, for development without hardware")
    ap.add_argument("--forecast-interval", type=float, default=3600.0,
                    help="seconds between NOAA forecast archive fetches (default 3600)")
    ap.add_argument("--no-forecast-archive", action="store_true",
                    help="don't archive NOAA forecasts, so nothing is scored")
    ap.add_argument("--seed-hours", type=float, default=0.0,
                    help="dev only: backfill this many hours of mock history before starting")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    try:
        sensor = open_sensor(mock=args.mock, bus=args.bus, address=int(args.address, 16),
                             altitude_m=args.altitude)
    except Exception as exc:
        LOG.error("Could not open the sensor: %s", exc)
        LOG.error("Run with --mock to develop without hardware.")
        return 1

    store = Store(args.db, retain_days=args.retain_days)
    if args.seed_hours > 0:
        LOG.info("seeding %.1f hours of mock history", args.seed_hours)
        LOG.info("backfilled %d readings", seed_history(store, args.seed_hours, args.altitude))
        LOG.info("backfilled %d simulated forecast rows", seed_forecasts(store, args.seed_hours))

    sampler = Sampler(sensor, store, args.interval)
    sampler.start()

    archiver = None
    if args.lat is not None and args.lon is not None and not args.no_forecast_archive:
        archiver = ForecastArchiver(store, args.lat, args.lon, interval=args.forecast_interval)
        archiver.start()
        LOG.info("archiving NOAA forecasts for %.4f,%.4f every %.0f min — scoring builds up over the next few days",
                 args.lat, args.lon, args.forecast_interval / 60)
    elif not args.no_forecast_archive:
        LOG.info("forecast scoring is off: pass --lat and --lon to turn it on")

    StationHandler.sampler = sampler
    StationHandler.archiver = archiver
    StationHandler.store = store
    StationHandler.config = {
        "name": args.name,
        "altitude_m": args.altitude,
        "sensor": "mock" if args.mock else "BME280",
        "interval_seconds": args.interval,
        "lat": args.lat,
        "lon": args.lon,
    }

    httpd = ThreadingHTTPServer((args.host, args.port), StationHandler)
    httpd.daemon_threads = True

    def shutdown(signum, _frame):
        LOG.info("signal %s — shutting down", signum)
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, shutdown)

    ip = local_ip()
    LOG.info("Sensor: %s, sampling every %ss", StationHandler.config["sensor"], args.interval)
    LOG.info("Serving the Skycast app from %s", APP_ROOT)
    LOG.info("Open  http://%s:%d/  (or http://localhost:%d/ on this machine)", ip, args.port, args.port)
    if args.altitude == 0.0 and not args.mock:
        LOG.warning("--altitude is 0, so sea-level pressure will be wrong. Pass your elevation in metres.")

    try:
        httpd.serve_forever()
    finally:
        sampler.stop()
        if archiver:
            archiver.stop()
        httpd.server_close()
        sensor.close()
        store.close()
        LOG.info("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
