#!/bin/sh
set -e

# Docker creates a directory at a bind-mount path when the host file doesn't
# exist yet. Detect that and replace it with the baked-in default so the app
# starts cleanly on first run.
if [ -d /app/config.json ]; then
  rmdir /app/config.json
  cp /app/config.default.json /app/config.json
  echo "[lazysunday] First run: seeded default config.json"
  echo "[lazysunday] Edit /lazysunday/config.json on the host and restart to customise."
fi

exec "$@"
