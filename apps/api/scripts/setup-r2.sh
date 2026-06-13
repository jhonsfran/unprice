#!/usr/bin/env bash
# Apply R2 lifecycle rules to the lakehouse bucket for the given environment.
# Run from apps/api: ./scripts/setup-r2.sh <env>
# Requires: WRANGLER_R2_SQL_AUTH_TOKEN not needed for lifecycle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIFECYCLE_FILE="$SCRIPT_DIR/r2-lifecycle.json"
WRANGLER_CONFIG="$API_DIR/wrangler.jsonc"

usage() {
  echo "Usage: $0 <environment>"
  echo ""
  echo "Environments:"
  echo "  dev"
  echo "  preview"
  echo "  prod"
  echo ""
  echo "The LAKEHOUSE bucket is resolved from wrangler.jsonc for the selected env."
  echo ""
  echo "Example:"
  echo "  $0 dev"
  exit 1
}

resolve_lakehouse_bucket() {
  local wrangler_config_path="$1"
  local environment="$2"

  node --input-type=module - "$wrangler_config_path" "$environment" <<'NODE'
import { readFileSync } from "node:fs"

const [, , configPath, envName] = process.argv

function stripJsonComments(text) {
  let result = ""
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  let escaped = false
  let stringDelimiter = ""

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]
    const next = text[index + 1]

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false
        result += current
      }
      continue
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      result += current

      if (escaped) {
        escaped = false
        continue
      }

      if (current === "\\") {
        escaped = true
        continue
      }

      if (current === stringDelimiter) {
        inString = false
        stringDelimiter = ""
      }

      continue
    }

    if (current === "\"" || current === "'") {
      inString = true
      stringDelimiter = current
      result += current
      continue
    }

    if (current === "/" && next === "/") {
      inLineComment = true
      index += 1
      continue
    }

    if (current === "/" && next === "*") {
      inBlockComment = true
      index += 1
      continue
    }

    result += current
  }

  return result
}

const content = readFileSync(configPath, "utf8")
const config = JSON.parse(stripJsonComments(content))
const envConfig = config?.env?.[envName]

if (!envConfig || typeof envConfig !== "object") {
  console.error(`Environment '${envName}' was not found in ${configPath}`)
  process.exit(1)
}

const bindingByEnv = {
  prod: "unprice_lakehouse_prod",
  preview: "unprice_lakehouse_dev",
  dev: "unprice_lakehouse_dev",
}

const allBuckets = [
  ...(Array.isArray(envConfig.r2_buckets) ? envConfig.r2_buckets : []),
  ...(Array.isArray(config.r2_buckets) ? config.r2_buckets : []),
]

const lakehouseBucket =
  allBuckets.find((bucket) => bucket?.binding === bindingByEnv[envName]) ??
  allBuckets.find((bucket) => bucket?.binding === "LAKEHOUSE")

if (!lakehouseBucket?.bucket_name) {
  console.error(`No LAKEHOUSE bucket configured for environment '${envName}' in ${configPath}`)
  process.exit(1)
}

process.stdout.write(String(lakehouseBucket.bucket_name))
NODE
}

if [[ $# -lt 1 ]]; then
  usage
fi

ENV="$1"

case "$ENV" in
  dev|preview|prod)
    ;;
  *)
    echo "Error: Unknown environment '$ENV'"
    usage
    ;;
esac

BUCKET="$(resolve_lakehouse_bucket "$WRANGLER_CONFIG" "$ENV")"

echo "Applying lifecycle rules to bucket: $BUCKET"
echo "Using config: $LIFECYCLE_FILE"
echo ""

cd "$API_DIR"
npx wrangler r2 bucket create "$BUCKET"
npx wrangler r2 bucket lifecycle set "$BUCKET" --file "$LIFECYCLE_FILE"

echo ""
echo "Lifecycle rules applied successfully."
echo ""
echo "To verify, run:"
echo "  npx wrangler r2 bucket lifecycle list $BUCKET"
