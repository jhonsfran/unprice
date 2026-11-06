"use client"

import { columnKey, columnLabel, formatRateAmount, perLabel } from "@unprice/services/pricing"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { cn } from "@unprice/ui/utils"
import { useState } from "react"
import type { Matrix, MatrixLine, MatrixStatus } from "./rate-card-format"

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

function StatusBadge({ status }: { status: MatrixStatus }) {
  const badge = STATUS_BADGE[status]
  return badge ? (
    <Badge variant={badge.variant} className="px-1.5 py-0 text-[10px]">
      {badge.label}
    </Badge>
  ) : null
}

/**
 * Prices as a vendor price sheet: a line per dimension value, a column per rate, "per 1M tokens"
 * under each column. A change view shows the rate a line had beside the one it gets. A feature
 * with no dimensions is one line, not a one-row table.
 */
export function PriceMatrix({
  matrix,
  currency,
  unit,
  limit,
  action,
  className,
}: {
  matrix: Matrix
  currency: string
  unit: string
  /** Show at most this many lines until the reader asks for all of them. */
  limit?: number
  /** What a line offers at its end, such as a way to end it; shown on hover. */
  action?: (line: MatrixLine) => React.ReactNode
  className?: string
}) {
  const [showAll, setShowAll] = useState(false)
  const shown = limit === undefined || showAll ? matrix.lines : matrix.lines.slice(0, limit)
  const hidden = matrix.lines.length - shown.length
  const hasColumns = matrix.columns.length > 0
  const applies = sharedApplies(matrix.lines)
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
            <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums">
              {line.text ??
                matrix.columns.map((column) => {
                  const cell = line.cells.get(columnKey(column))
                  return cell ? (
                    <span key={columnKey(column)} className="inline-flex items-baseline gap-1">
                      <RateCell cell={cell} currency={currency} />
                      <span className="text-muted-foreground">/ {perLabel(column, unit)}</span>
                    </span>
                  ) : null
                })}
            </span>
            <StatusBadge status={line.status} />
            <span className="ml-auto text-muted-foreground">{line.applies}</span>
            {actionCell(line)}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={cn("overflow-x-auto rounded-md border", className)}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
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
            <TableHead className={CELL}>
              {applies ? <span className="font-normal">{applies}</span> : "Applies"}
            </TableHead>
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
              <TableCell className={cn(CELL, "text-muted-foreground")}>
                {applies ? null : line.applies}
              </TableCell>
              {action && (
                <TableCell className={cn(CELL, "text-right")}>{actionCell(line)}</TableCell>
              )}
            </TableRow>
          ))}
          {hidden > 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={1 + Math.max(matrix.columns.length, 1) + 1 + (action ? 1 : 0)}
                className={cn(CELL, "text-muted-foreground")}
              >
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => setShowAll(true)}
                >
                  Show all {matrix.lines.length}
                </Button>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
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
