"use client"

import { CalendarClock, EyeOff, MoreVertical, RotateCw, SlidersHorizontal, Zap } from "lucide-react"
import { type KeyboardEvent, useState } from "react"

import type { FeatureType } from "@unprice/db/utils"
import { FEATURE_TYPES_MAPS } from "@unprice/db/utils"
import type { PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import { AMOUNT_PATTERN } from "@unprice/money"
import type { RouterInputs } from "@unprice/trpc/routes"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@unprice/ui/alert-dialog"
import { Button } from "@unprice/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { cn } from "@unprice/ui/utils"

import {
  type FeaturePriceRows,
  describeFeaturePrice,
  priceStateOf,
  scheduledFrom,
} from "../../_components/plan-prices"
import { type PriceShape, prefillDraft, priceInputOf, priceShapeOf } from "./price-block"
import { PricingModelIcon } from "./pricing-model"

/** The fields a cell sends with `planVersionFeatures.update`; each cell sends its own. */
export type CellPatch = Pick<
  RouterInputs["planVersionFeatures"]["update"],
  "featureType" | "config" | "limit" | "included" | "defaultQuantity" | "price"
>

export type CellField = "kind" | "limit" | "included" | "price"

/** What the server refused, shown under the cell that sent it. */
export type CellProblem = Readonly<{ field: CellField; message: string }>

/** The kinds in the order the select lists them. */
export const KINDS: readonly FeatureType[] = ["flat", "tier", "package", "usage"]

export function kindLabel(kind: FeatureType): string {
  return FEATURE_TYPES_MAPS[kind].shortLabel
}

const CELL_TRANSITION = "transition-[border-color,background-color,color] duration-150 ease-out"

/**
 * What picking a kind does. Fixed and Tiered commit at once. Bundle needs its size and Metered
 * needs a meter, so those open the sheet with the kind pending, unless the feature carries a
 * meter template the server snapshots on its own.
 */
export function kindChangeOf(
  row: PlanVersionFeatureDragDrop,
  kind: FeatureType
): { commit: CellPatch } | { configure: PlanVersionFeatureDragDrop } | null {
  if (kind === row.featureType) return null
  switch (kind) {
    case "flat":
    case "tier":
      return { commit: { featureType: kind, config: {} } }
    case "usage":
      return row.feature.meterConfig
        ? { commit: { featureType: "usage", config: { usageMode: "unit" } } }
        : {
            configure: {
              ...row,
              featureType: "usage",
              config: { usageMode: "unit" },
              meterConfig: undefined,
            },
          }
    case "package":
      return {
        configure: {
          ...row,
          featureType: "package",
          config: { units: row.config?.units },
          meterConfig: null,
          included: null,
        },
      }
  }
}

/** The Limit cell: the limit of a tiered or metered feature; a fixed fee or a bundle has none. */
export function limitCellOf(row: PlanVersionFeatureDragDrop): { value: string } | null {
  if (row.featureType === "flat" || row.featureType === "package") return null
  return { value: row.limit ? String(row.limit) : "" }
}

/**
 * The Included cell: a metered feature's free units (none across dimensions, ADR-0008 D5); for a
 * tiered or bundle feature the quantity a subscription starts with.
 */
export function includedCellOf(
  row: PlanVersionFeatureDragDrop
): { field: "included" | "defaultQuantity"; value: string } | null {
  switch (row.featureType) {
    case "flat":
      return null
    case "usage":
      return (row.meterConfig?.groupBy?.length ?? 0) > 0
        ? null
        : { field: "included", value: row.included ?? "" }
    case "tier":
    case "package":
      return { field: "defaultQuantity", value: String(row.defaultQuantity ?? 1) }
  }
}

export type PriceCell =
  | Readonly<{
      kind: "amount"
      shape: Exclude<PriceShape, "graduated">
      amount: string
      unit: string
      priced: boolean
      /** "from Nov 5, 2026" when the price shown has not started. */
      scheduled: string | null
    }>
  | Readonly<{
      kind: "summary"
      text: string
      priced: boolean
      action: "tiers" | "catalog" | "card"
    }>

/**
 * What the Price cell shows: an amount to type for a fixed, per-unit or bundle price; a summary
 * that opens the sheet for tiers, for prices by dimension, and for a row the decimal form cannot
 * state. A fixed feature with no row shows 0, so committing the cell includes it at $0.
 */
export function priceCellOf(
  row: PlanVersionFeatureDragDrop,
  rows: FeaturePriceRows | undefined,
  currency: string
): PriceCell {
  const unit = (row.unitOfMeasure ?? "units").replace(/s$/, "")
  const priced = priceStateOf(rows) !== "unpriced"
  const text = describeFeaturePrice(rows, currency, unit)
  const hasDimensions =
    (row.meterConfig?.groupBy?.length ?? 0) > 0 || (rows?.byDimension.length ?? 0) > 0
  if (hasDimensions) return { kind: "summary", text, priced, action: "catalog" }
  const shape = priceShapeOf(row.featureType, row.config?.usageMode)
  if (shape === "graduated") return { kind: "summary", text, priced, action: "tiers" }
  const current = rows?.current ?? rows?.scheduled ?? null
  const prefill = prefillDraft(current, shape)
  if (!prefill || prefill.kind !== "amount") {
    return { kind: "summary", text, priced, action: "card" }
  }
  return {
    kind: "amount",
    shape,
    amount: prefill.amount,
    unit,
    priced,
    scheduled: rows?.scheduled && !rows.current ? scheduledFrom(rows.scheduled) : null,
  }
}

const count = new Intl.NumberFormat("en")

/** A whole number of units, or what is wrong with the text. */
function wholeNumberOf(text: string): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = text.trim()
  if (trimmed === "") return { ok: true, value: 0 }
  const value = Number(trimmed)
  return Number.isInteger(value) && value >= 0
    ? { ok: true, value }
    : { ok: false, message: "A whole number, or empty for none." }
}

/**
 * One cell's input: mono, borderless until hovered or focused, committed on blur or Enter and
 * restored on Escape. `onCommit` answers what stopped the value, which stays under the cell.
 */
export function CellInput({
  value,
  label,
  placeholder,
  leading,
  trailing,
  inputMode = "numeric",
  disabled,
  problem,
  commitUnchanged = false,
  onCommit,
}: {
  value: string
  label: string
  placeholder?: string
  leading?: string
  trailing?: string
  inputMode?: "numeric" | "decimal"
  disabled?: boolean
  problem: string | null
  /** Commit on blur even when the text is what it was: a fixed feature's 0 prices it. */
  commitUnchanged?: boolean
  onCommit: (text: string) => string | null
}) {
  const [text, setText] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const message = error ?? problem

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (event.key === "Escape") {
      event.preventDefault()
      setText(value)
      setError(null)
      event.currentTarget.blur()
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          "flex h-7 items-center rounded border border-transparent bg-transparent font-mono text-xs tabular-nums",
          CELL_TRANSITION,
          !disabled && "focus-within:border-ring focus-within:bg-background hover:border-input",
          message && "border-destructive"
        )}
      >
        {leading && <span className="pl-2 text-muted-foreground">{leading}</span>}
        <input
          aria-label={label}
          aria-invalid={message ? true : undefined}
          inputMode={inputMode}
          className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-xs tabular-nums outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:text-muted-foreground"
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value)
            setError(null)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (text === value && !problem && !commitUnchanged) return
            setError(onCommit(text))
          }}
        />
        {trailing && (
          <span
            className="max-w-[76px] shrink-0 truncate pr-2 text-muted-foreground"
            title={trailing}
          >
            {trailing}
          </span>
        )}
      </div>
      {message && <p className="text-destructive text-xs">{message}</p>}
    </div>
  )
}

/** The feature itself: its kind's icon, title, slug, and the flags the sheet sets. */
export function FeatureCell({
  row,
  planBillingName,
  saving,
}: {
  row: PlanVersionFeatureDragDrop
  planBillingName: string | undefined
  saving: boolean
}) {
  const flags: { key: string; icon: typeof EyeOff; label: string; className?: string }[] = []
  if (row.metadata?.hidden) {
    flags.push({ key: "hidden", icon: EyeOff, label: "Hidden from the pricing page" })
  }
  if (row.featureType === "usage" && row.billingConfig.name !== planBillingName) {
    flags.push({ key: "billing", icon: CalendarClock, label: `Billed ${row.billingConfig.name}` })
  }
  if (
    row.featureType === "usage" &&
    row.resetConfig?.name &&
    row.resetConfig.name !== planBillingName
  ) {
    flags.push({ key: "reset", icon: RotateCw, label: `Resets ${row.resetConfig.name}` })
  }
  if (row.metadata?.realtime) {
    flags.push({
      key: "realtime",
      icon: Zap,
      label: "Reports usage in realtime",
      className: "text-warning",
    })
  }

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex size-6 shrink-0 items-center justify-center rounded border bg-background-bgSubtle text-muted-foreground">
        <PricingModelIcon type={row.featureType} className="size-3" />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-sm">{row.feature.title}</span>
          {saving && (
            <span
              role="status"
              aria-label="Saving"
              title="Saving"
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-info-solid"
            />
          )}
          {flags.map(({ key, icon: Icon, label, className }) => (
            <Icon
              key={key}
              role="img"
              aria-label={label}
              className={cn("size-3 shrink-0 text-muted-foreground", className)}
              strokeWidth={1.5}
            />
          ))}
        </div>
        <div className="truncate font-mono text-muted-foreground text-xs">{row.feature.slug}</div>
      </div>
    </div>
  )
}

/** The kind select and the details icon that opens the sheet. */
export function KindCell({
  value,
  disabled,
  problem,
  onChange,
  onConfigure,
}: {
  value: FeatureType
  disabled?: boolean
  problem: string | null
  onChange: (kind: FeatureType) => void
  onConfigure: () => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <Select
          value={value}
          onValueChange={(kind) => onChange(kind as FeatureType)}
          disabled={disabled}
        >
          <SelectTrigger
            aria-label="Kind"
            className={cn(
              "h-7 min-w-0 flex-1 rounded border-transparent px-2 text-xs",
              CELL_TRANSITION,
              !disabled && "hover:border-input focus:border-ring",
              problem && "border-destructive"
            )}
          >
            <SelectValue>{kindLabel(value)}</SelectValue>
          </SelectTrigger>
          <SelectContent className="text-xs">
            {KINDS.map((kind) => (
              <SelectItem
                key={kind}
                value={kind}
                description={FEATURE_TYPES_MAPS[kind].description}
              >
                {kindLabel(kind)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Configure feature"
          onClick={onConfigure}
        >
          <SlidersHorizontal className="size-3.5" strokeWidth={1.5} />
        </Button>
      </div>
      {problem && <p className="text-destructive text-xs">{problem}</p>}
    </div>
  )
}

const AMOUNT_TRAILING: Record<Exclude<PriceShape, "graduated">, (unit: string) => string> = {
  flat: () => "per cycle",
  unit: (unit) => `per ${unit}`,
  package: () => "per bundle",
}

const SUMMARY_ACTION: Record<"tiers" | "catalog" | "card", string> = {
  tiers: "Set tiers",
  catalog: "Price models",
  card: "Edit on the card",
}

/** The price: an amount to type, or the summary that opens the sheet. */
export function PriceCell({
  cell,
  currency,
  disabled,
  problem,
  onCommit,
  onConfigure,
}: {
  cell: PriceCell
  currency: string
  disabled?: boolean
  problem: string | null
  onCommit: (price: NonNullable<CellPatch["price"]> | null) => void
  onConfigure: () => void
}) {
  if (cell.kind === "summary") {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled={disabled}
          onClick={onConfigure}
          className={cn(
            "flex h-7 w-full items-center justify-between gap-2 rounded border border-transparent px-2 text-left font-mono text-xs tabular-nums",
            CELL_TRANSITION,
            !disabled &&
              "hover:border-input hover:bg-background focus-visible:border-ring focus-visible:outline-none",
            !cell.priced && "text-muted-foreground"
          )}
        >
          <span className="truncate">{cell.priced ? cell.text : "Not priced"}</span>
          {!disabled && (
            <span className="shrink-0 font-sans text-muted-foreground">
              {SUMMARY_ACTION[cell.action]}
            </span>
          )}
        </button>
        {problem && <p className="text-destructive text-xs">{problem}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5">
      <CellInput
        key={`${cell.shape}:${cell.amount}`}
        value={cell.amount}
        label="Price"
        placeholder={cell.shape === "flat" ? "0" : "0.02"}
        inputMode="decimal"
        leading={currency}
        trailing={AMOUNT_TRAILING[cell.shape](cell.unit)}
        disabled={disabled}
        problem={problem}
        commitUnchanged={!cell.priced}
        onCommit={(text) => {
          if (text.trim() === "") {
            if (cell.priced) onCommit(null)
            return null
          }
          const built = priceInputOf({ kind: "amount", amount: text })
          if (!built.ok) return built.message
          onCommit(built.price)
          return null
        }}
      />
      {cell.scheduled && (
        <span className="px-2 font-mono text-muted-foreground text-xs">{cell.scheduled}</span>
      )}
    </div>
  )
}

/** The Limit or Included cell: a whole number of units, or empty for none. */
export function UnitsCell({
  value,
  label,
  unit,
  decimal = false,
  disabled,
  problem,
  onCommit,
}: {
  value: string
  label: string
  unit: string
  /** Included units are a decimal string; a limit and a quantity are whole numbers. */
  decimal?: boolean
  disabled?: boolean
  problem: string | null
  onCommit: (value: number | string | null) => void
}) {
  return (
    <CellInput
      key={value}
      value={value}
      label={label}
      placeholder={decimal ? "0" : "none"}
      inputMode={decimal ? "decimal" : "numeric"}
      trailing={unit}
      disabled={disabled}
      problem={problem}
      onCommit={(text) => {
        if (decimal) {
          const trimmed = text.trim()
          if (trimmed !== "" && !AMOUNT_PATTERN.test(trimmed)) {
            return "A non-negative number, or empty for none."
          }
          onCommit(trimmed === "" ? null : trimmed)
          return null
        }
        const parsed = wholeNumberOf(text)
        if (!parsed.ok) return parsed.message
        onCommit(parsed.value)
        return null
      }}
    />
  )
}

/** A published version's cell: the fact in mono, never a disabled control. */
export function ReadOnlyCell({
  children,
  muted,
}: {
  children: React.ReactNode
  muted?: boolean
}) {
  return (
    <span className={cn("px-2 font-mono text-xs tabular-nums", muted && "text-muted-foreground")}>
      {children}
    </span>
  )
}

export function formatUnits(value: number | string | null | undefined, empty: string): string {
  if (value === null || value === undefined || value === "" || Number(value) === 0) return empty
  return count.format(Number(value))
}

const MENU_ITEM = "cursor-pointer text-xs"
const DESTRUCTIVE_ITEM =
  "cursor-pointer text-danger-text text-xs focus:bg-danger-solid focus:text-danger-foreground"

/** The row's menu: the sheet, the feature's definition, and removal behind a confirm. */
export function RowMenu({
  title,
  editable,
  onConfigure,
  onEditFeature,
  onRemove,
}: {
  title: string
  editable: boolean
  onConfigure: () => void
  onEditFeature: () => void
  onRemove: () => void
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Actions for ${title}`}
          >
            <MoreVertical className="size-3.5" strokeWidth={1.5} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem className={MENU_ITEM} onSelect={onConfigure}>
            {editable ? "Configure" : "View configuration"}
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM} onSelect={onEditFeature}>
            Edit feature
          </DropdownMenuItem>
          {editable && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={DESTRUCTIVE_ITEM}
                onSelect={() => setConfirmRemove(true)}
              >
                Remove from plan
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {title} from this version?</AlertDialogTitle>
            <AlertDialogDescription>
              Its prices on this version's card end. The feature stays in your library.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="button-default">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="button-danger"
              onClick={() => {
                setConfirmRemove(false)
                onRemove()
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
