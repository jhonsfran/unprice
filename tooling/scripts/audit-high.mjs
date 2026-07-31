import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const currentDir = dirname(fileURLToPath(import.meta.url))
const baselinePath = resolve(currentDir, "../audit/high-critical-baseline.json")
const baseline = new Set(JSON.parse(readFileSync(baselinePath, "utf8")))

const audit = spawnSync("pnpm", ["audit", "--json", "--audit-level", "high"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
})

if (!audit.stdout) {
  process.stderr.write(audit.stderr)
  process.exit(audit.status ?? 1)
}

let report
try {
  report = JSON.parse(audit.stdout)
} catch (error) {
  process.stderr.write(audit.stdout)
  process.stderr.write(audit.stderr)
  process.stderr.write(`Failed to parse pnpm audit JSON: ${String(error)}\n`)
  process.exit(1)
}

const current = new Set(
  Object.values(report.advisories ?? {})
    .filter((advisory) => advisory.severity === "high" || advisory.severity === "critical")
    .map((advisory) => advisory.github_advisory_id ?? String(advisory.id))
    .filter(Boolean)
)

const unexpected = [...current].filter((id) => !baseline.has(id)).sort()

if (unexpected.length > 0) {
  process.stderr.write("New high/critical pnpm audit advisories found:\n")
  for (const id of unexpected) {
    process.stderr.write(`- ${id}\n`)
  }
  process.exit(1)
}

const fixed = [...baseline].filter((id) => !current.has(id)).sort()
if (fixed.length > 0) {
  for (const _id of fixed) {
  }
}
