// import { featureUsageSchema } from "./utils"
// TODO: use this to get the token
// cat .tinyb | jq .token
// TODO: use for now https://mockingbird.tinybird.co

// console.info(JSON.stringify(featureUsageSchema, null, 2))

// const tbGenerator = new TinybirdGenerator({
//   schema: featureUsageSchema,
//   eps: 100, // events per second
//   limit: 1000, // limit of events to generate
//   endpoint: "https://api.tinybird.co", // endpoint to use
//   logs: true,
//   datasource: "feature_usage_v1", // datasource to use
//   token: process.env.TINYBIRD_TOKEN || "" // token to use
// })

// async function main() {

//   console.info("Generating data...")

//   await tbGenerator.generate()

//   console.info("Data generated successfully")
// }

// main()

import { randomUUID } from "node:crypto"
import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN || "",
  baseUrl: process.env.UNPRICE_API_URL || "http://localhost:8787",
})

async function generateData(customerId: string, async?: boolean) {
  const now = performance.now()

  const { result: entitlements, error } = await unprice.customers.getEntitlements(customerId)

  if (error) {
    console.error("Error getting entitlements", error)
    return
  }

  if (!entitlements?.length) {
    console.error("No entitlements found")
    return
  }

  for (let i = 0; i < 100; i++) {
    // ramdom usage between -10 and 100 (negative usage is allowed)
    const usage = Math.floor(Math.random() * 200) - 10
    // pick a random feature slug
    const featureSlug = entitlements[Math.floor(Math.random() * entitlements.length)]?.featureSlug!

    // pick a random feature slug
    const randomFeatureSlug =
      entitlements[Math.floor(Math.random() * entitlements.length)]?.featureSlug!

    if (randomFeatureSlug) {
      // verify the usage
      const nowDate = Date.now()
      const result = await unprice.customers.can({
        customerId,
        featureSlug: randomFeatureSlug,
      })

      const latency = Date.now() - nowDate
      console.info(`Latency: ${latency}ms`)

      console.info(
        `Verification ${randomFeatureSlug}, cache hit: ${result.result?.cacheHit} verified for ${customerId} in ${result.result?.latency}ms`
      )

      if (result.result?.allowed) {
        console.info(`Verification ${randomFeatureSlug} verified for ${customerId}`)

        // report usage
        // wait 200ms
        await new Promise((resolve) => setTimeout(resolve, 10))

        const result = await unprice.customers.reportUsage({
          customerId,
          featureSlug,
          usage,
          idempotenceKey: randomUUID(),
        })

        if (result.result?.allowed) {
          console.info(`Usage ${usage} ${async ? "async" : "sync"} reported for ${featureSlug}`)
        } else {
          console.error(
            `Usage ${usage} ${async ? "async" : "sync"} reported for ${featureSlug} failed`,
            result.result?.message
          )
        }
      } else {
        console.error(
          `Verification for ${randomFeatureSlug} and ${customerId} cannot be used`,
          result.result?.message
        )
      }
    }
  }

  console.info(`Time taken: ${performance.now() - now}ms`)
}

async function main() {
  // const customerFree = "cus_1MeUjVxFbv8DP9X7f1UW9"
  // const customerPro = "cus_11Sb5A8HkjB6AeG4QS9WM4"
  const customerFree = "cus_11Sb5A8HkjB6AeG4QS9WM4"
  // const customerEnterprise = "cus_1MVdMxZ45uJKDo5z48hYJ"

  // PRO plan
  // await generateData(customerPro, false)

  // FREE plan
  await generateData(customerFree, false)

  // ENTERPRISE plan
  // await generateData(customerEnterprise)
}

main()
