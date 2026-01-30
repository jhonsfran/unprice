import {
  MutationCache,
  type MutationMeta,
  QueryClient,
  defaultShouldDehydrateQuery,
} from "@tanstack/react-query"
import { TRPCClientError, type TRPCLink } from "@trpc/client"
import { httpBatchStreamLink } from "@trpc/client"
import { newId } from "@unprice/db/utils"
import type { AppRouter } from "@unprice/trpc/routes"
import { transformer } from "@unprice/trpc/transformer"
import { getErrorMessage } from "~/lib/handle-error"
import { toastAction } from "~/lib/toast"

export const getBaseUrl = () => {
  if (typeof window !== "undefined") return ""
  const vc = process.env.VERCEL_URL
  if (vc) return `https://${vc}`
  return "http://localhost:3000"
}

export const ANALYTICS_STALE_TIME = 1000 * 30 // 30 seconds

export const createQueryClient = () =>
  new QueryClient({
    mutationCache: new MutationCache({
      onError: (err, _vars, _ctx, mutation) => {
        const meta = (mutation.options?.meta ?? {}) as MutationMeta
        if (meta.suppressGlobalError) return

        if (typeof window === "undefined") {
          console.error(err)
          return
        }

        const msg =
          meta.mapMessage instanceof Function ? meta.mapMessage(err) : getErrorMessage(err)
        if (err instanceof TRPCClientError) {
          const requestId = err.data?.requestId
          toastAction("error", msg, { requestId })
        } else {
          toastAction("error-contact", msg)
        }
      },
    }),
    defaultOptions: {
      queries: {
        // Since queries are prefetched on the server, we set a stale time so that
        // queries aren't immediately refetched on the client
        staleTime: 60 * 1000,
      },
      dehydrate: {
        // include pending queries in dehydration
        // this allows us to prefetch in RSC and
        // send promises over the RSC boundary
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === "pending",
        serializeData: transformer.serialize,
      },
      hydrate: {
        deserializeData: transformer.deserialize,
      },
    },
  })

export const endingLinkClient = (opts?: {
  allEndpointsProcedures: {
    lambda: string[]
    edge: string[]
  }
}) =>
  ((runtime) => {
    const headers = {
      "unprice-request-id": newId("request"),
      "unprice-request-source": "app-react-query",
    }

    const edgeLink = httpBatchStreamLink({
      headers,
      transformer: transformer,
      url: `${getBaseUrl()}/api/trpc/edge`,
    })(runtime)

    const lambdaLink = httpBatchStreamLink({
      headers,
      transformer: transformer,
      url: `${getBaseUrl()}/api/trpc/lambda`,
    })(runtime)

    return (ctx) => {
      const path = ctx.op.path.split(".") as [string, ...string[]]
      // this is a bit of a hack, but it works for now
      // we try to infer the endpoint based on the path
      // and split the endpoint to the given runtime
      const endpoint = opts?.allEndpointsProcedures.lambda.includes(ctx.op.path) ? "lambda" : "edge"

      const newCtx = {
        ...ctx,
        op: { ...ctx.op, path: path.join(".") },
      }
      return endpoint === "edge" ? edgeLink(newCtx) : lambdaLink(newCtx)
    }
  }) satisfies TRPCLink<AppRouter>
