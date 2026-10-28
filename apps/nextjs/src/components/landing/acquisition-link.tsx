"use client"

import { Spinner } from "@unprice/ui/icons"
import { cn } from "@unprice/ui/utils"
import { track } from "@vercel/analytics"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import { type ComponentProps, type MouseEvent, useEffect, useState, useTransition } from "react"
import { getOrCreateConversionId, persistConversionId } from "~/lib/conversion-session"
import { type SignupIntent, acquisitionSignupHref } from "~/lib/signup-funnel"

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
  // The rendered link already carries the intent; a click adds the conversion session and goes.
  const initialHref = acquisitionSignupHref(intent)
  const [href, setHref] = useState(initialHref)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (href !== initialHref) {
      window.location.assign(href)
    }
  }, [href, initialHref])

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
          setHref(acquisitionSignupHref(intent, sessionId))
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
