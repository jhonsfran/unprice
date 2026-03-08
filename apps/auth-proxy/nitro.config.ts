import evlog from "evlog/nitro"
import { defineNitroConfig } from "nitropack/config"
import { env } from "./env"

export default defineNitroConfig({
  compatibilityDate: "2025-02-10",
  modules: [
    evlog({
      env: {
        service: "auth-proxy",
        environment: env.APP_ENV,
      },
      sampling: {
        rates: {
          info: env.APP_ENV === "production" ? 10 : 100,
          warn: 100,
          error: 100,
          debug: env.APP_ENV === "production" ? 0 : 100,
        },
        keep: [{ status: 400 }, { duration: 1000 }], // keep >= 400 status codes and requests that take longer than 1 second
      },
    }),
  ],
  preset: "vercel-edge",
})
