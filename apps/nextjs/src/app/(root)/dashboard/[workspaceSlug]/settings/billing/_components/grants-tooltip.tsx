"use client"

import { nFormatter } from "@unprice/db/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@unprice/ui/tooltip"
import { Info } from "lucide-react"

type GrantsDisplay = {
  grants: Array<{
    id: string
    name: string
    amount: number
    isFree: boolean
    source?: string
    percentOfTotal: number
  }>
  totalFromGrants: number
  paidGrants: Array<{
    id: string
    name: string
    amount: number
    isFree: boolean
    source?: string
    percentOfTotal: number
  }>
  freeGrants: Array<{
    id: string
    name: string
    amount: number
    isFree: boolean
    source?: string
    percentOfTotal: number
  }>
}

interface GrantsTooltipProps {
  data: GrantsDisplay
  unit?: string
}

export function GrantsTooltip({ data, unit = "" }: GrantsTooltipProps) {
  const { grants, totalFromGrants, paidGrants, freeGrants } = data

  if (!grants.length) return null

  return (
    <TooltipProvider>
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" />
            <span>
              {grants.length} grant{grants.length > 1 ? "s" : ""}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="w-72 p-0">
          <div className="space-y-3 p-3">
            <div className="font-medium text-foreground text-xs">Usage breakdown</div>

            <div className="space-y-1.5">
              <div className="flex h-2 w-full overflow-hidden rounded-full">
                {grants.map((grant, i) => (
                  <div
                    key={grant.id}
                    className={`h-full transition-all ${
                      grant.isFree
                        ? "bg-success-borderHover"
                        : i === 0
                          ? "bg-primary-borderHover"
                          : "bg-primary-borderHover"
                    }`}
                    style={{ width: `${grant.percentOfTotal}%` }}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-2">
              {paidGrants.length > 0 && (
                <div className="space-y-1">
                  {paidGrants.map((grant) => (
                    <div key={grant.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-primary-borderHover" />
                        <span className="text-muted-foreground">{grant.name}</span>
                      </div>
                      <div className="font-medium font-mono text-foreground tabular-nums">
                        {" "}
                        {nFormatter(grant.amount, { digits: 1 })}
                        {unit ? ` ${unit}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {freeGrants.length > 0 && (
                <div className="space-y-1">
                  <div className="text-muted-foreground text-xs uppercase tracking-wide">
                    Free / Custom
                  </div>
                  {freeGrants.map((grant) => (
                    <div key={grant.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-success-borderHover" />
                        <span className="text-muted-foreground">
                          {grant.name}
                          {grant.source && (
                            <span className="text-muted-foreground/60"> ({grant.source})</span>
                          )}
                        </span>
                      </div>
                      <div className="font-medium font-mono text-success tabular-nums">
                        {" "}
                        {nFormatter(grant.amount, { digits: 1 })}
                        {unit ? ` ${unit}` : ""}
                        <span className="ml-1 font-normal text-muted-foreground">(free)</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-between border-border border-t pt-2 text-xs">
              <span className="text-muted-foreground">Total from grants</span>
              <span className="font-medium font-mono text-foreground tabular-nums">
                {nFormatter(totalFromGrants, { digits: 1 })}
                {unit ? ` ${unit}` : ""}
              </span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
