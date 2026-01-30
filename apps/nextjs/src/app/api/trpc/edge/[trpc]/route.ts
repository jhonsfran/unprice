import { fetchRequestHandler } from "@trpc/server/adapters/fetch"

import { auth } from "@unprice/auth/server"
import { createTRPCContext } from "@unprice/trpc"
import { edgeRouter } from "@unprice/trpc/router/edge"
import { geolocation } from "@vercel/functions"
import { CorsOptions, setCorsHeaders } from "../../../_enableCors"

export const runtime = "edge"
export const preferredRegion = ["fra1"]
export const maxDuration = 10 // 10 seconds

const handler = auth(async (req) => {
  // when we use the middleware to rewrite the request, the path doesn't include the /api prefix
  // trpc under the hood uses the path to determine the procedure
  const pathName = req.nextUrl.pathname
  const endpoint = pathName.startsWith("/api") ? "/api/trpc/edge" : "/trpc/edge"

  const geo = geolocation(req)

  const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "Unknown"

  const response = await fetchRequestHandler({
    endpoint: endpoint,
    router: edgeRouter,
    req,
    createContext: () =>
      createTRPCContext({
        headers: req.headers,
        session: req.auth,
        req,
        opts: {
          ip: ip || "Unknown",
          userAgent: req.headers.get("user-agent") || "Unknown",
          source: req.headers.get("unprice-request-source") || "Unknown",
          pathname: pathName || "Unknown",
          method: req.method || "Unknown",
          continent: geo.countryRegion || "Unknown",
          country: geo.country || "Unknown",
          region: geo.region || "Unknown",
          city: geo.city || "Unknown",
        },
      }),
    onError: ({ error, path }) => {
      if (error.code === "INTERNAL_SERVER_ERROR") {
        // TODO: send to bug reporting
        console.error("Something went wrong", error)
      }

      console.info("❌  Error in tRPC handler (edge) on path", path)
      console.error(error)
    },
    // TODO: handling cache headers for public routes
    // https://trpc.io/docs/server/caching
  })

  setCorsHeaders(response)
  return response
})

export { handler as GET, CorsOptions as OPTIONS, handler as POST }
