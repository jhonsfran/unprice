"use client"

import { cn } from "@unprice/ui/utils"
import { type ReactNode, useEffect, useRef } from "react"

// The one entrance primitive for the landing page: rows written into the
// ledger. Everything renders visible by default (SSR, no-JS, reduced-motion,
// and content already in the viewport all show the final state); only
// elements that start below the fold get armed, then a one-shot
// IntersectionObserver flips them in. The transitions live in globals.css
// under [data-reveal]. The money path keeps its own WAAPI choreography —
// this is for the static artifacts around it.

export function Reveal({
  children,
  className,
  stagger = false,
  as: Tag = "div",
}: {
  children: ReactNode
  className?: string
  stagger?: boolean
  /** Element to render, so semantic containers (ol, ul) stay semantic. */
  as?: "div" | "ol" | "ul"
}) {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    // Already on screen (or close to it): no entrance, content stays put.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return

    el.setAttribute("data-reveal", "out")
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.setAttribute("data-reveal", "in")
          io.disconnect()
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <Tag
      // biome-ignore lint/suspicious/noExplicitAny: one ref serves div/ol/ul
      ref={ref as any}
      data-reveal-stagger={stagger ? "" : undefined}
      className={cn(className)}
    >
      {children}
    </Tag>
  )
}
