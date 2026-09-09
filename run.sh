#!/usr/bin/env bash
# Build the public database and serve the frontend locally.
#
# Usage:
#   ./run.sh          # serves on http://localhost:8642
#   PORT=3000 ./run.sh # or pick a different port
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${PORT:-8642}"

if [ ! -f data/music.sqlite ]; then
  echo "data/music.sqlite not found -- run the ETL scripts first (see README's Getting Started)." >&2
  exit 1
fi

echo "Building public database (site/public/music.sqlite)..."
python3 etl/build_public_db.py

echo ""
echo "Serving site/ at http://localhost:${PORT}/ (Ctrl+C to stop)"
cd site
exec python3 -m http.server "$PORT"
