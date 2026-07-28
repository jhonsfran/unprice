import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const rootManifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"))
const workspacePatterns = Array.isArray(rootManifest.workspaces)
  ? rootManifest.workspaces
  : rootManifest.workspaces?.packages

if (!Array.isArray(workspacePatterns)) {
  throw new Error("Root package.json must declare workspace patterns")
}

const workspacePackages = []

for (const pattern of workspacePatterns) {
  const match = pattern.match(/^([^*]+)\/\*$/)

  if (!match) {
    throw new Error(`Unsupported workspace pattern in release guard: ${pattern}`)
  }

  const workspaceRoot = path.join(repoRoot, match[1])
  const entries = await readdir(workspaceRoot, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const manifestPath = path.join(workspaceRoot, entry.name, "package.json")

    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
      workspacePackages.push({
        name: manifest.name,
        path: path.relative(repoRoot, manifestPath),
        private: manifest.private === true,
      })
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue
      }

      throw error
    }
  }
}

const publishablePackages = workspacePackages
  .filter((workspacePackage) => !workspacePackage.private)
  .sort((left, right) => left.name.localeCompare(right.name))
const publishableNames = publishablePackages.map((workspacePackage) => workspacePackage.name)
const expectedPublishableNames = ["@unprice/api"]

if (JSON.stringify(publishableNames) !== JSON.stringify(expectedPublishableNames)) {
  const packageList =
    publishablePackages.length > 0
      ? publishablePackages
          .map((workspacePackage) => `- ${workspacePackage.name} (${workspacePackage.path})`)
          .join("\n")
      : "- none"

  process.stderr.write(
    [
      "Refusing to publish: the Changesets workspace contains unexpected public packages.",
      `Expected: ${expectedPublishableNames.join(", ")}`,
      "Found:",
      packageList,
      "",
    ].join("\n")
  )
  process.exit(1)
}

process.stdout.write(`Publishable package guard passed: ${publishableNames.join(", ")}\n`)
