"use client"

import { cn } from "@unprice/ui/utils"
import { type ReactNode, useEffect, useRef } from "react"
import Balancer from "react-wrap-balancer"

/** One moment of an onboarding flow: its rail label and the heading it shows while current. */
export type OnboardingMoment = {
  label: string
  setup: string
  operative: string
  sub: string
}

/**
 * The frame every onboarding flow shares: an eyebrow with the moment counter, the moment's
 * heading (focused when the moment changes, so a screen reader hears the new step), and a panel
 * with the step rail above the flow's own body. `moments` is in flow order.
 */
export function OnboardingFrame<Id extends string>({
  eyebrow,
  label,
  moments,
  active,
  children,
}: {
  eyebrow: string
  /** The panel's accessible name. */
  label: string
  moments: Record<Id, OnboardingMoment>
  active: Id
  children: ReactNode
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousMomentRef = useRef<Id | null>(null)
  const ids = Object.keys(moments) as Id[]
  const activeIndex = ids.indexOf(active)
  const moment = moments[active]

  useEffect(() => {
    if (previousMomentRef.current !== null && previousMomentRef.current !== active) {
      headingRef.current?.focus({ preventScroll: true })
    }
    previousMomentRef.current = active
  }, [active])

  return (
    <div className="flex w-full flex-col gap-8">
      <header className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
          <span className="font-mono text-background-text text-xs uppercase tracking-widest">
            {eyebrow}
          </span>
          <span className="font-mono text-[10px] text-background-text tabular-nums">
            {String(activeIndex + 1).padStart(2, "0")} / {String(ids.length).padStart(2, "0")}
          </span>
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-primary text-background-textContrast text-display-3 outline-none"
        >
          <Balancer>
            <span className="text-background-text">{moment.setup}</span> {moment.operative}
          </Balancer>
        </h1>
        <p className="max-w-2xl text-background-text text-sm leading-6">{moment.sub}</p>
      </header>

      <section
        aria-label={label}
        className="overflow-hidden rounded-lg border border-background-border bg-surface-panel shadow-raised"
      >
        <ol className="grid grid-cols-3 border-background-border border-b bg-background-bgSubtle">
          {ids.map((id, index) => {
            const current = index === activeIndex
            const completed = index < activeIndex
            return (
              <li
                key={id}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2 border-background-border border-r px-3 py-3 text-xs last:border-r-0 sm:px-5",
                  current || completed ? "text-background-textContrast" : "text-background-text"
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px]",
                    // Blue marks the current moment (live context); amber stays
                    // reserved for the one primary action per view.
                    current
                      ? "bg-info-solid text-white"
                      : completed
                        ? "bg-success-solid text-white"
                        : "bg-background-bgActive text-background-text"
                  )}
                >
                  {index + 1}
                </span>
                <span className="truncate">{moments[id].label}</span>
              </li>
            )
          })}
        </ol>

        {children}
      </section>
    </div>
  )
}
