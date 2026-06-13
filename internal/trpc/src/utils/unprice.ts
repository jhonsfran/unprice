import { Unprice } from "@unprice/api"
import { env } from "#env"

export const unprice = new Unprice({
  token: env.UNPRICE_API_KEY,
  baseUrl: env.UNPRICE_API_URL,
})

export function createProjectScopedUnpriceClient(projectId: string) {
  return new Unprice({
    token: env.UNPRICE_API_KEY,
    baseUrl: env.UNPRICE_API_URL,
    headers: {
      "unprice-internal-secret": env.UNPRICE_INTERNAL_API_SECRET,
      "unprice-internal-project-id": projectId,
    },
  })
}
