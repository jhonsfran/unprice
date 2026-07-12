"use client"

import { useEffect } from "react"
import { getOrCreateConversionId, persistConversionId } from "~/lib/conversion-session"

export function UpdateMarketingCookie({ sessionId }: { sessionId?: string }) {
  const conversionId = getOrCreateConversionId(sessionId)

  const onFocus = () => {
    persistConversionId(conversionId)
  }

  useEffect(() => {
    persistConversionId(conversionId)

    window.addEventListener("focus", onFocus)

    return () => {
      window.removeEventListener("focus", onFocus)
    }
  }, [sessionId])

  return null
}
