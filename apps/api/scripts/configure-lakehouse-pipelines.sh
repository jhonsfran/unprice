#!/usr/bin/env bash
#
# Configure Cloudflare Pipelines + R2 Data Catalog sink for the events lakehouse source.
# Assumes R2 buckets already exist.
#
# Run from apps/api:
#   ./scripts/configure-lakehouse-pipelines.sh <environment> [options]
#
# Options:
#   --skip-lifecycle
#   --skip-compaction
#   --recreate
#   --delete-only
#   --name-prefix <prefix>
#   --name-suffix <suffix>   (default: "_<environment>")
#
set -euo pipefail

# Avoid interactive Wrangler prompts in automation scripts.
export CI="${CI:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMAS_DIR="$SCRIPT_DIR/schemas"
WRANGLER_CONFIG="$API_DIR/wrangler.jsonc"

SKIP_LIFECYCLE=false
SKIP_COMPACTION=false
RECREATE=false
DELETE_ONLY=false
ROLL_INTERVAL=300 # every 5 minutes
NAMESPACE="lakehouse"
NAME_PREFIX=""
NAME_SUFFIX=""

usage() {
  echo "Usage: $0 <environment> [options]"
  echo ""
  echo "Environments: dev | preview | prod"
  echo ""
  echo "Options:"
  echo "  --skip-lifecycle          Do not apply R2 lifecycle rules"
  echo "  --skip-compaction         Do not enable catalog compaction"
  echo "  --recreate                Delete existing pipelines/sinks/streams and recreate"
  echo "  --delete-only             Delete pipelines/sinks/streams and exit"
  echo "  --name-prefix <prefix>    Prefix for stream/sink/pipeline names"
  echo "  --name-suffix <suffix>    Suffix for stream/sink/pipeline names (default: _<environment>)"
  echo ""
  echo "Required env: WRANGLER_R2_SQL_AUTH_TOKEN (or CLOUDFLARE_API_TOKEN) for catalog and sinks"
  echo ""
  echo "Example:"
  echo "  WRANGLER_R2_SQL_AUTH_TOKEN=\$(cat .token) $0 preview"
  exit 1
}

resource_name() {
  local source="$1"
  local kind="$2"
  echo "${NAME_PREFIX}lakehouse_${source}_${kind}${NAME_SUFFIX}"
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

find_resource_id() {
  local kind="$1"
  local name="$2"
  local list_output=""

  case "$kind" in
    pipeline)
      if ! list_output="$(npx wrangler pipelines list --json --per-page 1000 2>/dev/null)"; then
        echo ""
        return 0
      fi
      ;;
    stream)
      if ! list_output="$(npx wrangler pipelines streams list --json --per-page 1000 2>/dev/null)"; then
        echo ""
        return 0
      fi
      ;;
    sink)
      if ! list_output="$(npx wrangler pipelines sinks list --json --per-page 1000 2>/dev/null)"; then
        echo ""
        return 0
      fi
      ;;
    *)
      echo ""
      return 0
      ;;
  esac

  printf "%s" "$list_output" | node -e '
const fs = require("node:fs")
const input = fs.readFileSync(0, "utf8")
const needle = process.argv[1]
const SINGLE_QUOTE = String.fromCharCode(39)
const JSON_BLOCK_KEYS = ["result", "results", "items", "data", "pipelines", "streams", "sinks"]

function extractBalancedBlocks(text) {
  const blocks = []
  const closeToOpen = { "]": "[", "}": "{" }
  const stack = []
  let start = -1
  let inSingle = false
  let inDouble = false
  let escaping = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (escaping) {
      escaping = false
      continue
    }

    if (char === "\\") {
      escaping = true
      continue
    }

    if (!inDouble && char === SINGLE_QUOTE) {
      inSingle = !inSingle
      continue
    }

    if (!inSingle && char === "\"") {
      inDouble = !inDouble
      continue
    }

    if (inSingle || inDouble) continue

    if (char === "[" || char === "{") {
      if (stack.length === 0) start = i
      stack.push(char)
      continue
    }

    if (char === "]" || char === "}") {
      if (stack.length === 0) continue
      const expectedOpen = closeToOpen[char]
      const actualOpen = stack[stack.length - 1]
      if (actualOpen !== expectedOpen) continue
      stack.pop()
      if (stack.length === 0 && start >= 0) {
        blocks.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }

  return blocks
}

function normalizeJsonLike(text) {
  return text
    .replace(/\[\s*Object\s*\]/g, "null")
    .replace(/\[\s*Array\s*\]/g, "[]")
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)(\s*:)/g, "$1\"$2\"$3")
    .replace(/\x27([^\x27\\]*(?:\\.[^\x27\\]*)*)\x27/g, (_, value) => {
      const unescaped = value.replace(/\\\x27/g, "\x27")
      const escaped = unescaped.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"")
      return `\"${escaped}\"`
    })
    .replace(/,\s*([}\]])/g, "$1")
}

function parseWithCandidates(text) {
  const trimmed = text.trim()
  const candidates = [trimmed, ...extractBalancedBlocks(text).map((block) => block.trim())].filter(Boolean)
  const seen = new Set()

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    try {
      return JSON.parse(candidate)
    } catch {
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizeJsonLike(candidate)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    try {
      return JSON.parse(normalized)
    } catch {
    }
  }

  return null
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function findIdNearNeedle(text, targetName) {
  if (!targetName) return ""
  const escapedNeedle = escapeRegExp(targetName)
  const namePattern = new RegExp(`[\\x27\\\"]${escapedNeedle}[\\x27\\\"]`)
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i += 1) {
    if (!namePattern.test(lines[i])) continue

    const start = Math.max(0, i - 12)
    const end = Math.min(lines.length, i + 13)
    const window = lines.slice(start, end).join("\n")
    const idMatch = window.match(/(?:id|uuid|pipeline_id|stream_id|sink_id)\s*:\s*[\x27\"]?([A-Za-z0-9_-]+)[\x27\"]?/)
    if (idMatch && idMatch[1]) return idMatch[1]
  }

  return ""
}

const parsed = parseWithCandidates(input)
if (!parsed) {
  process.stdout.write(findIdNearNeedle(input, needle))
  process.exit(0)
}

function toArray(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return []

  const queue = [value]
  const seen = new Set()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== "object") continue
    if (seen.has(current)) continue
    seen.add(current)

    for (const key of JSON_BLOCK_KEYS) {
      if (Array.isArray(current[key])) return current[key]
    }

    for (const item of Object.values(current)) {
      if (Array.isArray(item)) return item
      if (item && typeof item === "object") queue.push(item)
    }
  }

  return []
}

const rows = toArray(parsed)
const match = rows.find((row) => {
  if (!row || typeof row !== "object") return false
  const names = [
    row.name,
    row.pipeline,
    row.pipeline_name,
    row.stream,
    row.stream_name,
    row.sink,
    row.sink_name,
  ]
  return names.some((value) => value === needle)
})

if (!match) {
  process.stdout.write("")
  process.exit(0)
}

const id =
  match.id ??
  match.uuid ??
  match.pipeline_id ??
  match.stream_id ??
  match.sink_id

if (typeof id === "string" || typeof id === "number") {
  process.stdout.write(String(id))
  process.exit(0)
}

process.stdout.write("")
' "$name"
}

resource_exists() {
  local kind="$1"
  local name="$2"
  [[ -n "$(find_resource_id "$kind" "$name")" ]]
}

ensure_created() {
  local kind="$1"
  local name="$2"
  shift 2

  local output=""
  if output="$("$@" 2>&1)"; then
    if [[ -n "$output" ]]; then
      printf "%s\n" "$output"
    fi
    return 0
  fi

  if printf "%s" "$output" | grep -Eiq "(already exists|code:[[:space:]]*1002)"; then
    echo ">>> ${kind} already exists (create returned already exists): $name"
    return 0
  fi

  printf "%s\n" "$output" >&2
  return 1
}

delete_resource_if_exists() {
  local kind="$1"
  local name="$2"
  local id
  id="$(find_resource_id "$kind" "$name")"

  if [[ -z "$id" ]]; then
    echo "No $kind found for '$name'; skipping delete."
    return 0
  fi

  echo ">>> Deleting $kind: $name (id: $id)"
  case "$kind" in
    pipeline)
      npx wrangler pipelines delete "$id" --force
      ;;
    sink)
      npx wrangler pipelines sinks delete "$id" --force
      ;;
    stream)
      npx wrangler pipelines streams delete "$id" --force
      ;;
    *)
      echo "Unsupported resource kind for delete: $kind"
      return 1
      ;;
  esac
}

if [[ $# -lt 1 ]]; then
  usage
fi

ENV="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-lifecycle)
      SKIP_LIFECYCLE=true
      shift
      ;;
    --skip-compaction)
      SKIP_COMPACTION=true
      shift
      ;;
    --recreate)
      RECREATE=true
      shift
      ;;
    --delete-only)
      DELETE_ONLY=true
      shift
      ;;
    --name-prefix)
      NAME_PREFIX="${2:-}"
      if [[ -z "$NAME_PREFIX" ]]; then
        echo "Missing value for --name-prefix"
        usage
      fi
      shift 2
      ;;
    --name-suffix)
      NAME_SUFFIX="${2:-}"
      if [[ -z "$NAME_SUFFIX" ]]; then
        echo "Missing value for --name-suffix"
        usage
      fi
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

if [[ -z "$NAME_SUFFIX" ]]; then
  NAME_SUFFIX="_${ENV}"
fi

case "$ENV" in
  dev|preview|prod)
    ;;
  *)
    echo "Error: Unknown environment '$ENV'"
    usage
    ;;
esac

BUCKET="$(resolve_lakehouse_bucket "$WRANGLER_CONFIG" "$ENV")"

cd "$API_DIR"

TOKEN_SOURCE=""
if [[ -z "${WRANGLER_R2_SQL_AUTH_TOKEN:-}" ]]; then
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    export WRANGLER_R2_SQL_AUTH_TOKEN="$CLOUDFLARE_API_TOKEN"
    TOKEN_SOURCE="CLOUDFLARE_API_TOKEN"
  elif [[ "$DELETE_ONLY" != true ]]; then
    echo "Error: WRANGLER_R2_SQL_AUTH_TOKEN (or CLOUDFLARE_API_TOKEN) is required."
    echo "Create token with: Workers R2 Data Catalog (Read+Edit), Workers Pipelines (Read+Send+Edit), Workers R2 Storage (Read+Edit)."
    exit 1
  fi
else
  TOKEN_SOURCE="WRANGLER_R2_SQL_AUTH_TOKEN"
fi

echo "=== Environment: $ENV | Bucket: $BUCKET ==="
echo "=== Resource name format: ${NAME_PREFIX}lakehouse_events_<stream|sink|pipeline>${NAME_SUFFIX} ==="
if [[ "$DELETE_ONLY" != true && -n "$TOKEN_SOURCE" ]]; then
  echo "=== Using API token from: $TOKEN_SOURCE ==="
fi
echo ""

STREAM_SPECS=(
  "events:events:events"
)

print_pipeline_binding_hint() {
  local pipeline_name
  pipeline_name="$(resource_name "events" "pipeline")"

  echo "Update wrangler pipeline binding for env '$ENV':"
  echo "  \"pipelines\": ["
  echo "    {"
  echo "      \"pipeline\": \"$pipeline_name\","
  echo "      \"binding\": \"PIPELINE_EVENTS\""
  echo "    }"
  echo "  ]"
}
if [[ "$RECREATE" == true || "$DELETE_ONLY" == true ]]; then
  echo ">>> Cleanup mode: deleting existing pipelines/sinks/streams for this environment naming scheme"
  for spec in "${STREAM_SPECS[@]}"; do
    source="${spec%%:*}"
    pipeline_name="$(resource_name "$source" "pipeline")"
    sink_name="$(resource_name "$source" "sink")"
    stream_name="$(resource_name "$source" "stream")"

    delete_resource_if_exists "pipeline" "$pipeline_name"
    delete_resource_if_exists "sink" "$sink_name"
    delete_resource_if_exists "stream" "$stream_name"
    echo ""
  done
fi

if [[ "$DELETE_ONLY" == true ]]; then
  echo "Delete-only mode complete."
  exit 0
fi

echo ">>> Verifying bucket exists: $BUCKET"
if ! npx wrangler r2 bucket info "$BUCKET" >/dev/null 2>&1; then
  echo "Error: bucket '$BUCKET' not found or inaccessible. Create it first, then rerun."
  exit 1
fi
echo "Bucket exists."
echo ""

# --- 1. Enable R2 Data Catalog ---
echo ">>> Enabling R2 Data Catalog on bucket: $BUCKET"
npx wrangler r2 bucket catalog enable "$BUCKET" || echo "Catalog may already be enabled."
echo ""

# --- 2. (Optional) Enable compaction ---
if [[ "$SKIP_COMPACTION" != true ]]; then
  echo ">>> Enabling R2 Data Catalog compaction on bucket: $BUCKET"
  npx wrangler r2 bucket catalog compaction enable "$BUCKET" --token "$WRANGLER_R2_SQL_AUTH_TOKEN" || true
  echo ""
fi

# --- 3. Create streams for each source ---
for spec in "${STREAM_SPECS[@]}"; do
  source="$(echo "$spec" | cut -d: -f1)"
  schema_file="$(echo "$spec" | cut -d: -f2).json"
  stream_name="$(resource_name "$source" "stream")"
  schema_path="$SCHEMAS_DIR/$schema_file"
  if [[ ! -f "$schema_path" ]]; then
    echo "Schema not found: $schema_path"
    exit 1
  fi
  if resource_exists "stream" "$stream_name"; then
    echo ">>> Stream already exists: $stream_name"
  else
    echo ">>> Creating stream: $stream_name (schema: $schema_file)"
    ensure_created "Stream" "$stream_name" \
      npx wrangler pipelines streams create "$stream_name" \
      --schema-file "$schema_path" \
      --http-enabled true \
      --http-auth true
    echo "Ensured $stream_name"
  fi
  echo ""
done

# --- 4. Create sinks for each source ---
for spec in "${STREAM_SPECS[@]}"; do
  source="$(echo "$spec" | cut -d: -f1)"
  table="$(echo "$spec" | cut -d: -f3)"
  sink_name="$(resource_name "$source" "sink")"

  if resource_exists "sink" "$sink_name"; then
    echo ">>> Sink already exists: $sink_name"
  else
    echo ">>> Creating sink: $sink_name -> $NAMESPACE.$table"
    ensure_created "Sink" "$sink_name" \
      npx wrangler pipelines sinks create "$sink_name" \
      --type "r2-data-catalog" \
      --bucket "$BUCKET" \
      --roll-interval "$ROLL_INTERVAL" \
      --namespace "$NAMESPACE" \
      --table "$table" \
      --catalog-token "$WRANGLER_R2_SQL_AUTH_TOKEN"
    echo "Ensured $sink_name"
  fi
  echo ""
done

# --- 5. Create pipelines (stream -> sink) ---
for spec in "${STREAM_SPECS[@]}"; do
  source="$(echo "$spec" | cut -d: -f1)"
  stream_name="$(resource_name "$source" "stream")"
  sink_name="$(resource_name "$source" "sink")"
  pipeline_name="$(resource_name "$source" "pipeline")"

  if resource_exists "pipeline" "$pipeline_name"; then
    echo ">>> Pipeline already exists: $pipeline_name"
  else
    echo ">>> Creating pipeline: $pipeline_name (INSERT INTO $sink_name SELECT * FROM $stream_name)"
    ensure_created "Pipeline" "$pipeline_name" \
      npx wrangler pipelines create "$pipeline_name" \
      --sql "INSERT INTO $sink_name SELECT * FROM $stream_name"
    echo "Ensured $pipeline_name"
  fi
  echo ""
done

# --- 6. Apply R2 lifecycle rules ---
if [[ "$SKIP_LIFECYCLE" != true ]]; then
  echo ">>> Applying R2 lifecycle rules"
  "$SCRIPT_DIR/setup-r2.sh" "$ENV"
  echo ""
fi

echo "=== Done. ==="
echo ""
echo "Created or ensured:"
echo "  Stream:   ${NAME_PREFIX}lakehouse_events_stream${NAME_SUFFIX}"
echo "  Sink:     ${NAME_PREFIX}lakehouse_events_sink${NAME_SUFFIX}"
echo "  Pipeline: ${NAME_PREFIX}lakehouse_events_pipeline${NAME_SUFFIX}"
echo ""
echo "Next steps:"
echo "  - Get stream ingest endpoints: npx wrangler pipelines streams list"
echo "  - Query R2 SQL: npx wrangler r2 sql query \"<WAREHOUSE>\" \"SELECT * FROM $NAMESPACE.events LIMIT 10\""
echo ""
print_pipeline_binding_hint
