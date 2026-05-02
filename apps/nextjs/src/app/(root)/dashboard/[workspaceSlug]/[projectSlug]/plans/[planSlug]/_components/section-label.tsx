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
 * Collapsible disclosure that uses the same eyebrow styling as `SectionLabel`.
 * Wraps the standard shadcn Collapsible primitives.
 */
export function CollapsibleSection({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center justify-between rounded-md py-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground",
            focusRing
          )}
        >
          <span className="font-semibold uppercase tracking-wider">{label}</span>
          <ChevronDown
            className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  )
}
