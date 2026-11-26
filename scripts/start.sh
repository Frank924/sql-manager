#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"
if [[ ! -f backend/target/sql-manager-1.0.0.jar ]]; then
  printf '请先运行 ./scripts/build.sh 构建应用。\n' >&2
  exit 1
fi
export DATA_DIR="${DATA_DIR:-$project_root/data}"
exec java -jar backend/target/sql-manager-1.0.0.jar "$@"
