#!/usr/bin/env sh
set -eu

script_path="${1:?Usage: sh scripts/run-k6.sh <k6-script>}"
env_file_args=""
env_args=""

if [ -f ".env" ]; then
  env_file_args="--env-file .env"
fi

env_names="
BASE_URL
CUSTOMER_ID
EVENTS
PROJECT_ID
UNPRICE_TOKEN
VUS
"

for env_name in $env_names; do
  if printenv "$env_name" >/dev/null 2>&1; then
    env_args="$env_args -e $env_name"
  fi
done

docker run $env_file_args $env_args --rm --network=host -i \
  grafana/k6 run - < "$script_path"
