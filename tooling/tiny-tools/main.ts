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

function buildIngestionProperties(
  usage: number,
  meterConfig:
    | {
        aggregationMethod: "sum" | "count" | "max" | "latest"
        aggregationField?: string
      }
    | undefined
): Record<string, unknown> | null {
  if (!meterConfig) {
    return null
  }

  if (meterConfig.aggregationMethod === "count") {
    return {}
  }

  const aggregationField = meterConfig.aggregationField?.trim()
  if (!aggregationField) {
    return null
  }

  return { [aggregationField]: usage }
}

async function generateData(customerId: string, useAsyncIngestion = false) {
  const now = performance.now()

  const { result: entitlements, error } = await unprice.customers.getEntitlements({ customerId })

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
    const featureSlug = entitlements[Math.floor(Math.random() * entitlements.length)]?.featureSlug

    if (featureSlug) {
      // verify the usage
      const verificationAt = Date.now()
      const verification = await unprice.customers.verify({
        customerId,
        featureSlug,
      })

      const latency = Date.now() - verificationAt

      if (verification.error) {
        console.error(`Error verifying ${featureSlug}`, verification.error)
        continue
      }

      const eventSlug = verification.result?.meterConfig?.eventSlug
      const ingestionProperties = buildIngestionProperties(usage, verification.result?.meterConfig)

      console.info(
        `Verification ${featureSlug}, status: ${verification.result?.status}, allowed: ${verification.result?.allowed} for ${customerId} in ${latency}ms`
      )

      if (!eventSlug) {
        console.error(`No eventSlug found for ${featureSlug}, skipping ingestion`)
        continue
      }

      if (!ingestionProperties) {
        console.error(
          `Invalid meter config for ${featureSlug}, cannot build ingestion properties`,
          verification.result?.meterConfig
        )
        continue
      }

      if (verification.result?.allowed) {
        console.info(`Verification ${featureSlug} verified for ${customerId}`)

        // ingest usage
        // wait 200ms
        await new Promise((resolve) => setTimeout(resolve, 10))

        if (useAsyncIngestion) {
          const result = await unprice.events.ingest({
            customerId,
            eventSlug,
            properties: ingestionProperties,
            idempotencyKey: randomUUID(),
          })

          if (result.error) {
            console.error(`Async ingestion failed for ${eventSlug}`, result.error)
            continue
          }

          if (result.result?.accepted) {
            console.info(`Usage ${usage} async ingested for ${eventSlug}`)
          } else {
            console.error(`Usage ${usage} async ingestion was not accepted for ${eventSlug}`)
          }
          continue
        }

        const result = await unprice.events.ingestSync({
          customerId,
          eventSlug,
          featureSlug,
          properties: ingestionProperties,
          idempotencyKey: randomUUID(),
        })

        if (result.error) {
          console.error(`Sync ingestion failed for ${featureSlug}`, result.error)
          continue
        }

        if (result.result?.allowed) {
          console.info(`Usage ${usage} sync ingested for ${featureSlug}`)
        } else {
          console.error(
            `Usage ${usage} sync ingestion rejected for ${featureSlug}`,
            result.result?.rejectionReason,
            result.result?.message
          )
        }
      } else {
        console.error(
          `Verification for ${featureSlug} and ${customerId} cannot be used`,
          verification.result?.message
        )
      }
    }
  }

  console.info(`Time taken: ${performance.now() - now}ms`)
}

async function main() {
  // const customerFree = "cus_1MeUjVxFbv8DP9X7f1UW9"
  // const customerPro = "cus_11Sb5A8HkjB6AeG4QS9WM4"
  const customerFree = "cus_11Uy2rEe341EKVni7HyuEx"
  // const customerEnterprise = "cus_1MVdMxZ45uJKDo5z48hYJ"

  // PRO plan
  // await generateData(customerPro, false)

  // FREE plan
  await generateData(customerFree, false)

  // ENTERPRISE plan
  // await generateData(customerEnterprise)
}

main()
