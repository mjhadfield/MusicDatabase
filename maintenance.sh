#!/usr/bin/env bash
# Launch the local maintenance UI for pulling fresh data (etl/refresh.py
# wrapped in a small web dashboard). Local only -- see etl/maintenance/server.py.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

exec python3 etl/maintenance/server.py
