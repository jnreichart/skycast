# Skycast home weather station

A Raspberry Pi with a BME280 sensor that measures your actual back garden —
temperature, humidity and pressure — and serves both a JSON API and the Skycast
web app over your home network.

The app shows your readings next to NOAA's forecast, including how far your yard
differs from the official NWS station it's forecasting against.

## Why the Pi serves the app too

A page loaded over HTTPS is not allowed to read a plain-HTTP address on your LAN —
browsers block it as mixed content. The hosted copy at `jnreichart.github.io/skycast`
therefore can't ever see your Pi.

So the Pi serves the app itself. One box, one origin, no certificates, no cloud
account, and nothing to configure in the browser. Use `http://skycast.local:8000/`
at home, and keep the GitHub Pages copy for the forecast when you're out.

## Parts

| Part | Approx. | Notes |
|---|---|---|
| Raspberry Pi Zero 2 W | $15 | Any Pi with WiFi works. A Zero 2 W draws ~0.7 W, so it can run on a small solar/USB supply. |
| microSD card, 16 GB+ | $8 | A good one. Cheap cards are the usual cause of a station that dies after two months. |
| **BME280** breakout, I2C | $5 | Make sure it says BME280, not BMP280 — the BMP has no humidity sensor. |
| Female-to-female jumper wires | $3 | 4 needed. |
| Radiation shield | $10–40 | Bought mini Stevenson screen, or 6 stacked plastic plant saucers. **Not optional** — see below. |
| IP65 junction box | $12 | For the Pi itself. |
| Cable gland | $2 | So the sensor cable leaves the box without letting water in. |
| Outdoor-rated USB cable | $10 | Or run the Pi indoors with only the sensor outside. |

Total: roughly **$65**, less if you have a Pi and a card already.

### Upgrade worth considering

The BME280's humidity reading drifts after repeated condensation. If you want
humidity you can still trust in two years, use an **SHT31-D** ($15) for temperature
and humidity and keep the BME280 for pressure. Both are I2C and can share the bus.

## Siting — this matters more than the sensor

An unshielded sensor in sunlight reads **5–10 °C too high**. Almost every bad home
weather station is a siting problem, not a hardware problem.

- **Always inside a radiation shield.** White, vented, sun never touching the sensor.
- **1.25–2 m above ground**, over grass if you have it. Not over paving, gravel or decking — they re-radiate heat well into the evening.
- **Away from the house.** Walls store heat; aim for at least 1.5 m clear, north-facing in the northern hemisphere.
- **Nowhere near** an air-conditioner outlet, dryer vent, boiler flue or a car's parking spot.
- **Keep the Pi's own heat away from the sensor.** A Pi in a sealed box warms a BME280 sitting next to it by several degrees. Put the sensor in the shield on a 30–50 cm cable, with the Pi in its box below or behind. Keep that cable under about 1 m — I2C gets unreliable past that.

The firmware already helps: it uses the BME280's *forced mode*, taking one reading
then going idle, so the chip barely self-heats.

## Wiring

Four wires, I2C. With the Pi powered **off**:

| BME280 | Raspberry Pi | Physical pin |
|---|---|---|
| VIN (or VCC) | 3.3 V | 1 |
| GND | GND | 6 |
| SCL | GPIO 3 / SCL | 5 |
| SDA | GPIO 2 / SDA | 3 |

Use **3.3 V, not 5 V**, unless your breakout explicitly has a regulator.

## Install

On the Pi, with Raspberry Pi OS already set up and on your WiFi:

```bash
sudo raspi-config nonint do_i2c 0
sudo apt update && sudo apt install -y python3-smbus i2c-tools git
```

Confirm the sensor is seen — you want `76` (or `77`) in the grid:

```bash
i2cdetect -y 1
```

Then clone and run:

```bash
git clone https://github.com/jnreichart/skycast.git ~/skycast
cd ~/skycast/station
python3 server.py --altitude 1624 --name "Back garden" --lat 39.7392 --lon -104.9903
```

- `--altitude` is **metres** above sea level. It's what converts your station pressure to the sea-level figure everyone else quotes; get it from any map app. Leave it wrong and your pressure will be wrong.
- `--lat` / `--lon` are optional. If set, the app opens on that forecast with nothing stored in the browser — which is what you want for a wall display.
- `--address 0x77` if `i2cdetect` showed 77.

Open `http://<pi-address>:8000/` from any device at home.

### Run it at boot

```bash
sudo ./install.sh --altitude 1624 --name "Back garden" --lat 39.7392 --lon -104.9903
```

That installs a systemd service, starts it, and enables it at boot. Afterwards:

```bash
sudo systemctl status skycast-station
journalctl -u skycast-station -f
```

### Develop without hardware

Runs anywhere, including Windows:

```bash
python3 server.py --mock --seed-hours 30 --altitude 1624
```

`--mock` generates plausible readings on a daily cycle; `--seed-hours` backfills
history so the chart has something to draw. Readings are labelled *simulated* in
the app so you can't mistake them for real ones.

## API

All endpoints allow cross-origin reads, so you can pull from Home Assistant,
Grafana, a script, or anything else on your network.

| Endpoint | Returns |
|---|---|
| `GET /api/current` | Latest reading: temperature, humidity, dew point, station and sea-level pressure, 3-hour pressure trend, 24-hour extremes. |
| `GET /api/history?hours=24&points=300` | Averaged time series, bucketed to at most `points` entries. `hours` accepts up to 90 days. |
| `GET /api/health` | Service state, uptime, read count, last sensor error. |

Temperatures are °C and pressures Pa; the app converts for display.

```bash
curl http://skycast.local:8000/api/current
```

## Storage

Readings go into `station/station.db` (SQLite, WAL mode). At the default 30-second
interval that's about 2,900 rows a day — roughly 40 MB a year, pruned after 400 days
(`--retain-days`). Back it up by copying the file.

## Where this could go next

- **Rain gauge and anemometer.** Tipping-bucket and reed-switch units are a GPIO interrupt each; they'd slot into the sampler as extra fields.
- **Report to CWOP.** NOAA ingests Citizen Weather Observer Program data, so your readings could feed the forecasts you're reading.
- **Forecast scoring.** Archive NOAA's hourly forecast each day and compare it against what the station actually measured — a running record of how accurate your local forecast really is.
- **Access from outside the house.** A Tailscale or Cloudflare tunnel gives you HTTPS without opening a port.
