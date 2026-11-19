# Skycast — NOAA weather forecasts by location

A zero-dependency web app that predicts the weather for any U.S. location using the
National Weather Service API (`api.weather.gov`, run by NOAA).

## Features

- **Location**: use your device's location, search by city or ZIP code, or type `lat, lon`.
  Recent places are remembered, and the URL hash (`#39.7392,-104.9903`) makes any forecast bookmarkable.
- **Current conditions** from the nearest reporting NWS station (temperature, feels-like, wind/gusts,
  humidity, dew point, pressure, visibility).
- **Prediction at a glance**: when rain/snow is likely to start and stop, the temperature trend,
  wind outlook, and the most comfortable 3-hour window to be outside. All of it is worked out from NOAA's hourly grid forecast.
- **Hourly forecast** (24/48/72 h): a temperature line and a precipitation-chance chart that share one
  crosshair tooltip. You can also switch to a table, and move through the hours with the arrow keys.
- **7-day forecast** with a weekly temperature-range bar. Select a day to read NOAA's full day and night text.
- **Active NWS alerts** (warnings, watches, advisories), sorted by severity.
- **Forecaster's discussion**: the latest Area Forecast Discussion from your local NWS office.
- °F / °C toggle, light and dark themes, mobile layout, auto-refresh every 15 minutes.

## Home weather station (optional)

[`station/`](station/) turns a Raspberry Pi with a BME280 sensor into your own
weather station. It samples temperature, humidity and pressure, stores the history
in SQLite, and serves both a JSON API and this web app over your home network.

The app then shows your actual back garden next to NOAA's forecast — including how
far your readings differ from the official NWS station it forecasts against — plus a
24-hour history chart and a 3-hour pressure trend.

It also **scores the forecast**. The station archives NOAA's hourly prediction for
your grid, then compares it against what your sensor went on to measure, giving you
a running verdict like *"NOAA's 24-hour forecast runs 2.0° too warm at your station"*
broken down by lead time from 1 to 48 hours.

The Pi serves the app itself on purpose: an HTTPS page can't read a plain-HTTP
address on your LAN, so the hosted copy could never see your sensor. Same box, same
origin, no certificates and no cloud account.

Roughly $65 of parts. See [station/README.md](station/README.md) for the parts list,
wiring, siting (which matters more than the hardware), and setup. To try it without
any hardware:

```bash
python3 station/server.py --mock --seed-hours 30
```

## Run it

Serve the folder with any static server, then open http://localhost:8000:

```bash
python -m http.server 8000
```

or

```bash
npx serve -l 8000
```

Opening `index.html` directly also works. Some browsers block geolocation on `file://`, though, so use the server if you want "My location".

## How it works

| Step | Endpoint |
|---|---|
| Resolve location → NWS grid | `GET /points/{lat},{lon}` |
| 7-day forecast (12-h periods) | `GET /gridpoints/{office}/{x},{y}/forecast` |
| Hourly forecast (~156 h) | `GET /gridpoints/{office}/{x},{y}/forecast/hourly` |
| Current conditions | `GET /gridpoints/.../stations` → `GET /stations/{id}/observations` |
| Alerts | `GET /alerts/active?point={lat},{lon}` |
| Forecaster's discussion | `GET /products/types/AFD/locations/{office}` |

NOAA has no geocoder, so place search uses the free [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api).
Neither API needs a key.

The NWS API sometimes returns 500/503 errors on grid endpoints, so requests are retried with backoff.
If observations or alerts fail, the rest of the page still loads.

## Files

```
index.html      page structure
styles.css      design tokens (light/dark), layout, components
js/format.js    unit conversion and time zone–aware formatting
js/icons.js     inline SVG weather icons and NOAA text → icon mapping
js/noaa.js      NWS API client and Open-Meteo place search
js/charts.js    hourly SVG charts and table
js/station.js   home station discovery, readings panel and history chart
js/accuracy.js  forecast-vs-measured scoring card and chart
js/app.js       state, rendering, insights, search, geolocation

station/        optional Raspberry Pi weather station
  bme280.py     sensor driver (+ mock for development)
  store.py      SQLite history, trends, extremes and forecast scoring
  forecast.py   archives NOAA's hourly forecast for later scoring
  server.py     sampler, JSON API, and static serving of this app
  install.sh    systemd service installer
```

Coverage: the United States and its territories only (an NWS limitation).
For official warnings, always check [weather.gov](https://www.weather.gov).
