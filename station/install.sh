#!/usr/bin/env bash
# Install the Skycast station as a systemd service that starts at boot.
#
#   sudo ./install.sh --altitude 1624 --name "Back garden" --lat 39.7392 --lon -104.9903
#
# Re-running it is safe: the unit file is rewritten and the service restarted.
set -euo pipefail

ALTITUDE=0
NAME="Home station"
PORT=8000
INTERVAL=30
ADDRESS=0x76
LAT=""
LON=""

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Options: --altitude M  --name TEXT  --port N  --interval S  --address 0x76|0x77  --lat X  --lon Y"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --altitude) ALTITUDE="$2"; shift 2 ;;
    --name)     NAME="$2";     shift 2 ;;
    --port)     PORT="$2";     shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --address)  ADDRESS="$2";  shift 2 ;;
    --lat)      LAT="$2";      shift 2 ;;
    --lon)      LON="$2";      shift 2 ;;
    -h|--help)  usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "This needs root to write the systemd unit. Re-run with sudo." >&2
  exit 1
fi

STATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The service should run as the user who owns the checkout, not as root.
RUN_USER="$(stat -c '%U' "$STATION_DIR")"
PYTHON="$(command -v python3 || true)"
UNIT=/etc/systemd/system/skycast-station.service

if [[ -z "$PYTHON" ]]; then
  echo "python3 not found on PATH." >&2
  exit 1
fi

if [[ "$ALTITUDE" == "0" ]]; then
  echo "Note: --altitude is 0, so sea-level pressure will be wrong."
  echo "      Pass your elevation in metres to fix it."
fi

ARGS="--port $PORT --interval $INTERVAL --altitude $ALTITUDE --address $ADDRESS --name '$NAME'"
[[ -n "$LAT" && -n "$LON" ]] && ARGS="$ARGS --lat $LAT --lon $LON"

echo "Installing service"
echo "  directory : $STATION_DIR"
echo "  user      : $RUN_USER"
echo "  arguments : $ARGS"

cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Skycast home weather station
Documentation=https://github.com/jnreichart/skycast
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$STATION_DIR
ExecStart=/bin/sh -c "exec $PYTHON $STATION_DIR/server.py $ARGS"
Restart=always
RestartSec=5
# The service only ever needs its own directory and the network.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload
systemctl enable skycast-station >/dev/null
systemctl restart skycast-station

sleep 2
if systemctl is-active --quiet skycast-station; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  echo "Running. Open:"
  echo "  http://${IP:-localhost}:$PORT/"
  echo "  http://$(hostname).local:$PORT/   (if mDNS is available on your network)"
  echo
  echo "Logs:  journalctl -u skycast-station -f"
else
  echo
  echo "The service failed to start. Recent log:" >&2
  journalctl -u skycast-station -n 20 --no-pager >&2
  exit 1
fi
