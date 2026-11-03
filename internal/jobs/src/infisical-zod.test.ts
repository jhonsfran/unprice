import { InfisicalSDK } from "@infisical/sdk"
import { expect, it } from "vitest"

it("keeps the deployment secret-sync SDK usable with Zod v4", async () => {
  const client = new InfisicalSDK({ siteUrl: "https://infisical.test" })
  const requests: { url: string; authorization: unknown }[] = []
  client.axiosInstance.defaults.adapter = async (config) => {
    requests.push({ url: config.url ?? "", authorization: config.headers.Authorization })
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: config.url?.includes("universal-auth/login")
        ? { accessToken: "test-token" }
        : { secrets: [{ secretKey: "EXAMPLE", secretValue: "test-value" }] },
    }
  }

  await client.auth().universalAuth.login({ clientId: "test-id", clientSecret: "test-secret" })
  const result = await client.secrets().listSecrets({
    environment: "preview",
    projectId: "test-project",
    secretPath: "/app",
  })

  expect(result.secrets.map(({ secretKey, secretValue }) => [secretKey, secretValue])).toEqual([
    ["EXAMPLE", "test-value"],
  ])
  expect(requests).toHaveLength(2)
  expect(requests[1]?.authorization).toBe("Bearer test-token")
  expect(requests[1]?.url).toContain("/api/v3/secrets/raw")
})
