import { createRequire } from "node:module"
import { syncEnvVars } from "@trigger.dev/build/extensions/core"
import { defineConfig } from "@trigger.dev/sdk/v3"

export default defineConfig({
  build: {
    extensions: [
      syncEnvVars(async (ctx) => {
        // Load the build-only SDK natively: Jiti v1 otherwise transforms its
        // Zod v4 dependency and loses the named `z` export.
        const { InfisicalSDK } = createRequire(import.meta.url)("@infisical/sdk") as typeof import(
          "@infisical/sdk"
        )
        const client = new InfisicalSDK()

        await client.auth().universalAuth.login({
          clientId: process.env.INFISICAL_CLIENT_ID!,
          clientSecret: process.env.INFISICAL_CLIENT_SECRET!,
        })

        const { secrets } = await client.secrets().listSecrets({
          environment: ctx.environment,
          projectId: process.env.INFISICAL_PROJECT_ID!,
          secretPath: "/app",
        })

        return secrets.map((secret) => ({
          name: secret.secretKey,
          value: secret.secretValue,
        }))
      }),
    ],
  },
  project: "proj_syspguczrngzfidpjzoy",
  logLevel: "info",
  enableConsoleLogging: true,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  maxDuration: 300, // 300 seconds or 5 minutes
})
