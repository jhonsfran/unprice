"use client"

import { APP_DOMAIN, AUTH_ROUTES } from "@unprice/config"
import { track } from "@vercel/analytics"
import { Link } from "next-view-transitions"
import { type ComponentProps, type MouseEvent, useEffect, useState } from "react"
import { getOrCreateConversionId, persistConversionId } from "~/lib/conversion-session"
import { ACQUISITION_SIGNUP_URL, buildAuthHref } from "~/lib/signup-funnel"

type AcquisitionSource = "header" | "hero" | "closing_cta" | "manifesto"

type AcquisitionLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  pendingLabel: string
  source: AcquisitionSource
}

function getAcquisitionHref(sessionId: string): string {
  return new URL(
    buildAuthHref(AUTH_ROUTES.SIGNUP, { sessionId, intent: "paid-action" }),
    APP_DOMAIN
  ).toString()
}

function isPrimaryUnmodifiedClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  const { currentTarget } = event

  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !currentTarget.hasAttribute("target") &&
    !currentTarget.hasAttribute("download")
  )
}

export function AcquisitionLink({
  children,
  onClick,
  pendingLabel,
  source,
  ...props
}: AcquisitionLinkProps) {
  const [href, setHref] = useState(ACQUISITION_SIGNUP_URL)
  const [isPending, setIsPending] = useState(false)

  useEffect(() => {
    const sessionId = getOrCreateConversionId()
    persistConversionId(sessionId)
    setHref(getAcquisitionHref(sessionId))
  }, [])

  return (
    <Link
      {...props}
      prefetch
      href={href}
      aria-busy={isPending || undefined}
      aria-disabled={isPending || undefined}
      className={isPending ? `${props.className ?? ""} pointer-events-none` : props.className}
      onClick={(event) => {
        onClick?.(event)

        if (!isPrimaryUnmodifiedClick(event)) return

        event.preventDefault()
        setIsPending(true)

        const sessionId = getOrCreateConversionId()
        persistConversionId(sessionId)
        track("funnel_acquisition_cta_selected", { source })

        window.requestAnimationFrame(() => {
          window.location.assign(getAcquisitionHref(sessionId))
        })
      }}
    >
      {isPending ? pendingLabel : children}
    </Link>
  )
}
