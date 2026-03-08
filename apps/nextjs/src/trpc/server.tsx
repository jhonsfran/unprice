import "server-only"

import { dehydrate } from "@tanstack/react-query"
import { HydrationBoundary } from "@tanstack/react-query"
import type { TRPCQueryOptions } from "@trpc/tanstack-react-query"
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query"
import { getSession } from "@unprice/auth/server-rsc"
import { COOKIES_APP } from "@unprice/config"
import { newId } from "@unprice/db/utils"
import { createCallerFactory, createTRPCContext } from "@unprice/trpc"
import { appRouter } from "@unprice/trpc/routes"
import { cookies, headers } from "next/headers"
import { cache } from "react"
import { getRequestLoggers, withEvlog } from "~/lib/evlog"
import { createQueryClient } from "./shared"

/**
 * This wraps the `createTRPCContext` helper and provides the required context for the tRPC API when
 * handling a tRPC call from a React Server Component.
 */
const createContext = cache(
  withEvlog(async () => {
    const heads = new Headers(headers())
    const activeWorkspaceSlug = cookies().get(COOKIES_APP.WORKSPACE)?.value ?? ""
    const activeProjectSlug = cookies().get(COOKIES_APP.PROJECT)?.value ?? ""
    const requestId = newId("request")
    const { logger, requestLogger } = getRequestLoggers(requestId)

    heads.set("unprice-request-source", "rsc")
    heads.set(COOKIES_APP.WORKSPACE, activeWorkspaceSlug)
    heads.set(COOKIES_APP.PROJECT, activeProjectSlug)
    heads.set("unprice-request-id", requestId)

    return createTRPCContext({
      session: await getSession(),
      headers: heads,
      logger,
      requestLogger,
    })
  })
)

/**
 * Create a stable getter for the query client that
 * will return the same client during the same request.
 */
const getQueryClient = cache(createQueryClient)

export const api = createCallerFactory(appRouter)(createContext)

export const trpc = createTRPCOptionsProxy({
  router: appRouter,
  queryClient: getQueryClient,
  ctx: createContext,
})

export function HydrateClient(props: { children: React.ReactNode }) {
  const queryClient = getQueryClient()
  const dehydratedState = dehydrate(queryClient)

  return <HydrationBoundary state={dehydratedState}>{props.children}</HydrationBoundary>
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export function prefetch<T extends ReturnType<TRPCQueryOptions<any>>>(queryOptions: T) {
  const queryClient = getQueryClient()

  if (queryOptions.queryKey[1]?.type === "infinite") {
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    void queryClient.prefetchInfiniteQuery(queryOptions as any)
  } else {
    void queryClient.prefetchQuery(queryOptions)
  }
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export function batchPrefetch<T extends ReturnType<TRPCQueryOptions<any>>>(queryOptionsArray: T[]) {
  const queryClient = getQueryClient()

  for (const queryOptions of queryOptionsArray) {
    if (queryOptions.queryKey[1]?.type === "infinite") {
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      void queryClient.prefetchInfiniteQuery(queryOptions as any)
    } else {
      void queryClient.prefetchQuery(queryOptions)
    }
  }
}
