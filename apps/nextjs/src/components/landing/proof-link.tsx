"use client"

import { track } from "@vercel/analytics"
import type { ComponentProps } from "react"

// The proof path, instrumented. The acquisition CTA has always been tracked;
// the paths a skeptic takes instead — the demo, the source, the SDK — were
// not, which made "which altitude leaked?" unanswerable on the one day the
// answer matters (marketing-framework.md, Measurement).
//
// Anchors stay anchors: no preventDefault, no navigation takeover. The event
// fires and the browser does what it was going to do anyway, so a blocked
// analytics script never costs the reader the click. `href` is required and
// passed explicitly rather than spread, so this stays a navigation element.

type ProofSource = "hero_demo" | "demo_source" | "demo_benchmark" | "integration_sdk"

export function ProofLink({
  source,
  href,
  onClick,
  ...props
}: ComponentProps<"a"> & { source: ProofSource; href: string }) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event)
        track("funnel_proof_link_selected", { source })
      }}
    />
  )
}
