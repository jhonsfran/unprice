"use client"

import { APP_DOMAIN, AUTH_ROUTES } from "@unprice/config"
import { Spinner } from "@unprice/ui/icons"
import { cn } from "@unprice/ui/utils"
import { track } from "@vercel/analytics"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import { type ComponentProps, type MouseEvent, useEffect, useState, useTransition } from "react"
import { getOrCreateConversionId, persistConversionId } from "~/lib/conversion-session"
import {
  ACQUISITION_SIGNUP_URL,
  type SignupIntent,
  buildAuthHref,
  nextAfterAuth,
} from "~/lib/signup-funnel"

type AcquisitionSource =
  | "header"
  | "hero"
  | "closing_cta"
  | "manifesto"
  | "budgets_hero"
  | "budgets_cta"

type AcquisitionLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  source: AcquisitionSource
  /** What the visitor came to start. It sets the signup copy and where they land after auth. */
  intent?: SignupIntent
}

function getAcquisitionHref(sessionId: string, intent: SignupIntent): string {
  return new URL(
    buildAuthHref(AUTH_ROUTES.SIGNUP, { sessionId, intent, next: nextAfterAuth(intent) }),
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
  source,
  intent = "paid-action",
  ...props
}: AcquisitionLinkProps) {
  const [href, setHref] = useState(ACQUISITION_SIGNUP_URL)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (href !== ACQUISITION_SIGNUP_URL) {
      window.location.assign(href)
    }
  }, [href])

  return (
    <Link
      {...props}
      prefetch
      href={href}
      aria-busy={isPending || undefined}
      aria-disabled={isPending || undefined}
      className={cn(props.className, isPending && "pointer-events-none")}
      onClick={(event) => {
        onClick?.(event)

        if (!isPrimaryUnmodifiedClick(event) || isPending) return

        event.preventDefault()

        const sessionId = getOrCreateConversionId()
        persistConversionId(sessionId)
        track("funnel_acquisition_cta_selected", { source })

        startTransition(() => {
          setHref(getAcquisitionHref(sessionId, intent))
        })
      }}
    >
      {children}
      {isPending ? (
        <Spinner aria-hidden data-icon="inline-end" className="size-3.5 animate-spin" />
      ) : (
        <ArrowRight aria-hidden data-icon="inline-end" className="size-3.5" />
      )}
    </Link>
  )
}
