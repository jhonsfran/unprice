import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// Use the installed CLI's loader, not tsx/Vitest: only Jiti's CommonJS
// transformation reproduces the production config-loading failure.
const cliPackage = import.meta.resolve("trigger.dev/package.json")
const { loadConfig } = await import(new URL("./dist/esm/config.js", cliPackage))

test("Trigger CLI loads the Infisical extension with Zod v4", async () => {
  const config = await loadConfig({ cwd: fileURLToPath(new URL("../", import.meta.url)) })

  assert.equal(config.project, "proj_syspguczrngzfidpjzoy")
  assert.ok(config.build.extensions.some((extension) => extension.name === "SyncEnvVarsExtension"))
})

test("CLI-loaded secret sync uses the native SDK without network requests", async () => {
  const require = createRequire(import.meta.url)
  const sdkRequire = createRequire(require.resolve("@infisical/sdk"))
  const axios = sdkRequire("axios")
  const originalAdapter = axios.defaults.adapter
  const requests = []
  const layers = []
  axios.defaults.adapter = async (config) => {
    requests.push(config)
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: config.url.includes("universal-auth/login")
        ? { accessToken: "test-token" }
        : { secrets: [{ secretKey: "EXAMPLE", secretValue: "test-value" }] },
    }
  }

  try {
    const config = await loadConfig({ cwd: fileURLToPath(new URL("../", import.meta.url)) })
    const extension = config.build.extensions.find((item) => item.name === "SyncEnvVarsExtension")
    await extension.onBuildComplete(
      {
        target: "deploy",
        config,
        logger: {
          spinner: () => ({ stop() {} }),
          warn: (_message, error) => {
            throw error
          },
        },
        addLayer: (layer) => layers.push(layer),
      },
      { environment: "preview", deploy: { env: {} } }
    )
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers.Authorization, "Bearer test-token")
    assert.equal(
      new URL(requests[1].url, "https://infisical.test").searchParams.get("environment"),
      "preview"
    )
    assert.equal(layers[0].deploy.env.EXAMPLE, "test-value")
  } finally {
    axios.defaults.adapter = originalAdapter
  }
})
