import { createUnpriceDrain } from "@unprice/observability"
import { defineNitroPlugin } from "nitropack/runtime"
import { env } from "../../env"

const drain = createUnpriceDrain({
  environment: env.APP_ENV,
  token: env.AXIOM_API_TOKEN,
  dataset: env.AXIOM_DATASET,
})

export default defineNitroPlugin((nitroApp) => {
  if (!drain) {
    return
  }

  // Register the drain with evlog
  nitroApp.hooks.hook("evlog:drain", drain)
  nitroApp.hooks.hook("close", () => drain.flush())
})
