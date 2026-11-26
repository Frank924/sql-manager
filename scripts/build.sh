#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root/ui-prototype"
npm ci
npm run build
cd "$project_root"
./mvnw -B -f backend/pom.xml package
jar_path="$project_root/backend/target/sql-manager-1.0.0.jar"
deploy_dir="$project_root/target/deploy"
mkdir -p "$deploy_dir"
cp "$jar_path" "$deploy_dir/sql-manager.jar"
cp Dockerfile "$deploy_dir/Dockerfile"
printf '\nBuilt: %s\nDocker deployment files: %s\n' "$jar_path" "$deploy_dir"
