#!/bin/sh
set -e

# If config.json doesn't exist inside /app/config, seed it from default
if [ ! -f /app/config/config.json ]; then
  cp /app/config.default.json /app/config/config.json
  echo "[lazysunday] First run: seeded config/config.json from default"
fi

exec "$@"