"use client"

import { track } from "@vercel/analytics"
import { usePathname, useSearchParams } from "next/navigation"
import { useEffect } from "react"
import { createFunnelPageEventClaimer } from "~/lib/signup-funnel"

const claimFunnelPageEvent = createFunnelPageEventClaimer()

export function FunnelPageEvent({ next }: { next?: string | null }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams.toString()
  const pageKey = search ? `${pathname}?${search}` : pathname

  useEffect(() => {
    if (!claimFunnelPageEvent(pageKey)) {
      return
    }

    track("funnel_signup_page_reached", { has_destination: Boolean(next) })
  }, [next, pageKey])

  return null
}
