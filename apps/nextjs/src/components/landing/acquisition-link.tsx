"use client"

import { track } from "@vercel/analytics"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import type { ComponentProps } from "react"
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

export function AcquisitionLink({
  children,
  onClick,
  source,
  intent = "paid-action",
  ...props
}: AcquisitionLinkProps) {
  return (
    <Link
      {...props}
      prefetch
      href={acquisitionSignupHref(intent)}
      onClick={(event) => {
        onClick?.(event)
        track("funnel_acquisition_cta_selected", { source })
      }}
    >
      {children}
      <ArrowRight aria-hidden data-icon="inline-end" className="size-3.5" />
    </Link>
  )
}
