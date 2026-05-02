"use client"

import { ChevronDown } from "lucide-react"
import type React from "react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@unprice/ui/collapsible"
import { HelpCircle } from "@unprice/ui/icons"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn, focusRing } from "@unprice/ui/utils"

/**
 * Standard eyebrow label used at the top of every section in the feature editor.
 * Pairs a small uppercase title with an optional tooltip and an optional right-side action slot.
 */
export function SectionLabel({
  children,
  tooltip,
  action,
  className,
}: {
  children: React.ReactNode
  tooltip?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
      <div className="flex items-center gap-1.5">
        <h4 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          {children}
        </h4>
        {tooltip && (
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="size-3 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-[280px]">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {action}
    </div>
  )
}

/**
 * Numbered stage indicator + section heading, used for the staged feature-editor flow
 * (1. How customers pay → 2. Configure → 3. More).
 */
export function NumberedStep({
  number,
  label,
  subtitle,
  action,
  children,
  className,
}: {
  number: number
  label: string
  subtitle?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/10 font-mono font-semibold text-[12px] text-foreground">
            {number}
          </span>
          <h4 className="font-semibold text-foreground text-xs uppercase tracking-wider">
            {label}
          </h4>
          {subtitle && (
            <span className="truncate font-normal text-muted-foreground text-xs normal-case tracking-normal">
              {subtitle}
            </span>
          )}
        </div>
        {action}
      </div>
      <div className="pl-[34px]">{children}</div>
    </section>
  )
}

/**
 * Collapsible disclosure that uses the same eyebrow styling as `SectionLabel`.
 * Optional `summary` is shown next to the chevron when the section is collapsed,
 * giving a one-line "what's inside" preview.
 */
export function CollapsibleSection({
  label,
  summary,
  open,
  onOpenChange,
  children,
  hasError,
}: {
  label: string
  summary?: React.ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  /** When true, the trigger renders with a destructive tint so users notice an unhandled validation error inside. */
  hasError?: boolean
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "group flex w-full items-center justify-between gap-3 rounded-md border bg-background-bgSubtle px-3 py-2 text-muted-foreground text-xs transition-colors hover:bg-background-bgHover",
            hasError &&
              "border-destructive/50 bg-destructive/5 text-destructive hover:bg-destructive/10",
            focusRing
          )}
        >
          <span className="flex items-center gap-2">
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-200",
                open ? "rotate-0" : "-rotate-90"
              )}
            />
            <span className="font-semibold uppercase tracking-wider">{label}</span>
            {hasError && (
              <span
                aria-label="This section has errors"
                className="size-1.5 shrink-0 rounded-full bg-destructive"
              />
            )}
          </span>
          {!open && summary && (
            <span className="line-clamp-1 normal-case tracking-normal">{summary}</span>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-3 pt-3 pb-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
