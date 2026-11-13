"use client"

import { columnKey, columnLabel, formatRateAmount, perLabel } from "@unprice/services/pricing"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { cn } from "@unprice/ui/utils"
import { Search } from "lucide-react"
import { useState } from "react"
import {
  type Matrix,
  type MatrixLine,
  type MatrixStatus,
  isCustomCostRow,
} from "~/components/pricing/rate-card-format"

const STATUS_BADGE: Partial<
  Record<MatrixStatus, { label: string; variant: "info" | "success" | "warning" | "secondary" }>
> = {
  scheduled: { label: "scheduled", variant: "info" },
  added: { label: "new", variant: "success" },
  changed: { label: "changed", variant: "warning" },
  retiring: { label: "ending", variant: "secondary" },
}

const CELL = "h-9 py-1.5 text-xs"

function title(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** When every line applies alike, the table says it once instead of once per line. */
export function sharedApplies(lines: readonly MatrixLine[]): string | null {
  const first = lines[0]?.applies ?? null
  return first !== null && lines.every((line) => line.applies === first) ? first : null
}

/**
 * When a line applies, as the table states it. A current price on a draft card has no date
 * worth reading: nobody pays it yet, so "since <the day it was set>" only raises a question.
 */
export function visibleApplies(line: MatrixLine, datesCurrent: boolean): string {
  return !datesCurrent && line.status === "current" ? "" : line.applies
}

export function StatusBadge({ status }: { status: MatrixStatus }) {
  const badge = STATUS_BADGE[status]
  return badge ? (
    <Badge variant={badge.variant} className="px-1.5 py-0 text-[10px]">
      {badge.label}
    </Badge>
  ) : null
}

/** A line's price without dimensions: its words, or each rate with what it is per. */
export function LinePrice({
  line,
  matrix,
  currency,
  unit,
}: {
  line: MatrixLine
  matrix: Matrix
  currency: string
  unit: string
}) {
  if (line.text !== null) return <span className="tabular-nums">{line.text}</span>
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums">
      {matrix.columns.map((column) => {
        const cell = line.cells.get(columnKey(column))
        return cell ? (
          <span key={columnKey(column)} className="inline-flex items-baseline gap-1">
            <RateCell cell={cell} currency={currency} />
            <span className="text-muted-foreground">/ {perLabel(column, unit)}</span>
          </span>
        ) : null
      })}
    </span>
  )
}

/**
 * Prices as a vendor price sheet: a line per dimension value, a column per rate, "per 1M tokens"
 * under each column. A change view shows the rate a line had beside the one it gets. A feature
 * with no dimensions is one line, not a one-row table. A long sheet shows its first lines, a search
 * box and "Show all", and grows in the page rather than scrolling inside it.
 */
export function PriceMatrix({
  matrix,
  currency,
  unit,
  limit,
  action,
  datesCurrent = true,
  className,
}: {
  matrix: Matrix
  currency: string
  unit: string
  /** Show this many lines and a way to show the rest; past it a search box filters them. */
  limit?: number
  /** What a line offers at its end, such as a way to end it; shown on hover. */
  action?: (line: MatrixLine) => React.ReactNode
  /** Whether a current line says since when it applies; a draft card's do not. */
  datesCurrent?: boolean
  className?: string
}) {
  const [query, setQuery] = useState("")
  const long = limit !== undefined && matrix.lines.length > limit
  const needle = query.trim().toLowerCase()
  const [showAll, setShowAll] = useState(false)
  const matched = needle
    ? matrix.lines.filter((line) => line.label.toLowerCase().includes(needle))
    : matrix.lines
  const shown = long && !showAll ? matched.slice(0, limit) : matched
  const hidden = matched.length - shown.length
  const hasColumns = matrix.columns.length > 0
  const appliesOf = (line: MatrixLine) => visibleApplies(line, datesCurrent)
  const dated = matrix.lines.map(appliesOf)
  const showApplies = dated.some((text) => text !== "")
  const applies = showApplies
    ? sharedApplies(matrix.lines.map((line) => ({ ...line, applies: appliesOf(line) })))
    : null
  const actionCell = (line: MatrixLine) => {
    const node = action?.(line)
    return node ? (
      <span className="inline-flex opacity-0 transition-opacity duration-150 ease-out focus-within:opacity-100 group-hover:opacity-100">
        {node}
      </span>
    ) : null
  }

  if (matrix.dimensions.length === 0) {
    return (
      <div className={cn("flex flex-col divide-y rounded-md border", className)}>
        {shown.map((line) => (
          <div key={line.key} className="group flex min-h-9 items-center gap-3 px-3 py-1.5 text-xs">
            <LinePrice line={line} matrix={matrix} currency={currency} unit={unit} />
            <StatusBadge status={line.status} />
            <span className="ml-auto text-muted-foreground">{appliesOf(line)}</span>
            {actionCell(line)}
          </div>
        ))}
      </div>
    )
  }

  const columnCount =
    1 + Math.max(matrix.columns.length, 1) + (showApplies && !applies ? 1 : 0) + (action ? 1 : 0)

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {long && (
        <div className="relative">
          <Search
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label={`Search ${matrix.dimensions.join(", ")}`}
            placeholder={`Search ${matrix.lines.length} ${matrix.dimensions.map((d) => `${d}s`).join(", ")}`}
            className="h-8 pr-20 pl-8 font-mono text-xs placeholder:font-sans"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {needle && (
            <span className="-translate-y-1/2 absolute top-1/2 right-2.5 text-muted-foreground text-xs tabular-nums">
              {matched.length} of {matrix.lines.length}
            </span>
          )}
        </div>
      )}
      {/* No scroll area of its own: a nested one traps the wheel and the page stops scrolling. */}
      <div className="overflow-clip rounded-md border">
        <table className="w-full caption-bottom text-sm">
          <TableHeader>
            <TableRow className="bg-background-bgSubtle hover:bg-background-bgSubtle">
              <TableHead className={CELL}>{matrix.dimensions.map(title).join(" · ")}</TableHead>
              {hasColumns ? (
                matrix.columns.map((column) => (
                  <TableHead key={columnKey(column)} className={cn(CELL, "text-right")}>
                    <span className="block leading-tight">{columnLabel(column)}</span>
                    <span className="block font-normal text-[11px] text-muted-foreground leading-tight">
                      per {perLabel(column, unit)}
                    </span>
                  </TableHead>
                ))
              ) : (
                <TableHead className={CELL}>Rate</TableHead>
              )}
              {showApplies && !applies && <TableHead className={CELL}>In effect</TableHead>}
              {action && (
                <TableHead className={cn(CELL, "w-20")}>
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((line) => (
              <TableRow
                key={line.key}
                className={cn("group", line.status === "ended" && "opacity-70")}
              >
                <TableCell className={cn(CELL, "font-mono")}>
                  <span className="inline-flex items-center gap-2">
                    {line.label}
                    {line.row && isCustomCostRow(line.row) && (
                      <Badge variant="secondary" className="px-1.5 py-0 font-sans text-[10px]">
                        custom
                      </Badge>
                    )}
                    <StatusBadge status={line.status} />
                  </span>
                </TableCell>
                {line.text !== null ? (
                  <TableCell
                    className={cn(CELL, "tabular-nums")}
                    colSpan={Math.max(matrix.columns.length, 1)}
                  >
                    {line.text}
                  </TableCell>
                ) : (
                  matrix.columns.map((column) => (
                    <TableCell
                      key={columnKey(column)}
                      className={cn(CELL, "text-right tabular-nums")}
                    >
                      <RateCell cell={line.cells.get(columnKey(column))} currency={currency} />
                    </TableCell>
                  ))
                )}
                {showApplies && !applies && (
                  <TableCell className={cn(CELL, "text-muted-foreground")}>
                    {appliesOf(line)}
                  </TableCell>
                )}
                {action && (
                  <TableCell className={cn(CELL, "text-right")}>{actionCell(line)}</TableCell>
                )}
              </TableRow>
            ))}
            {long && (hidden > 0 || showAll) && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columnCount} className={cn(CELL, "text-muted-foreground")}>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => setShowAll(!showAll)}
                  >
                    {showAll ? "Show fewer" : `Show all ${matched.length}`}
                  </Button>
                </TableCell>
              </TableRow>
            )}
            {shown.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columnCount} className={cn(CELL, "text-muted-foreground")}>
                  No {matrix.dimensions.join(", ")} matches “{query.trim()}”.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </table>
      </div>
      {applies && (
        <p className="text-muted-foreground text-xs">
          {title(applies.startsWith("since") ? `in effect ${applies}` : applies)}
        </p>
      )}
    </div>
  )
}

function RateCell({
  cell,
  currency,
}: {
  cell: { after: bigint | null; before: bigint | null } | undefined
  currency: string
}) {
  if (!cell) return <span className="text-muted-foreground">—</span>
  const after = cell.after === null ? null : formatRateAmount(cell.after, currency)
  const before = cell.before === null ? null : formatRateAmount(cell.before, currency)
  if (before !== null && before !== after) {
    return (
      <span className="inline-flex flex-col items-end leading-tight">
        <span className="text-muted-foreground line-through">{before}</span>
        <span>{after ?? "removed"}</span>
      </span>
    )
  }
  return <span>{after}</span>
}
