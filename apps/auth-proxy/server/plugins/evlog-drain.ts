import { createDrain } from "@unprice/observability"
import { defineNitroPlugin } from "nitropack/runtime"
import { env } from "../../env"

// Wrap your custom drain in the pipeline
const drain = createDrain({
  environment: env.APP_ENV,
  token: env.AXIOM_API_TOKEN,
  dataset: env.AXIOM_DATASET,
})

export default defineNitroPlugin((nitroApp) => {
  // Register the drain with evlog
  nitroApp.hooks.hook("evlog:drain", drain)
})
