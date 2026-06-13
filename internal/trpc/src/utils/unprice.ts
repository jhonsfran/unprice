import { Unprice } from "@unprice/api"
import { env } from "#env"

export const unprice = new Unprice({
  token: env.UNPRICE_API_KEY,
  baseUrl: env.UNPRICE_API_URL,
})
