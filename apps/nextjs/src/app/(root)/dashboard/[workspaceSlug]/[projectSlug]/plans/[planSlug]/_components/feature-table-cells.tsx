"use client"

import { type PricingShape, pricingShape } from "@unprice/services/pricing"

import { singularUnit } from "@unprice/services/pricing"

import { CalendarClock, EyeOff, MoreVertical, RotateCw, SlidersHorizontal, Zap } from "lucide-react"
import { type KeyboardEvent, useReducer, useRef, useState } from "react"

import type { FeatureType } from "@unprice/db/utils"
import { FEATURE_TYPES_MAPS } from "@unprice/db/utils"
import type { PlanVersionFeatureDragDrop, RateRow } from "@unprice/db/validators"
import { AMOUNT_PATTERN, formatMoney } from "@unprice/money"
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
} from "~/components/pricing/plan-prices"
import { cellCommitOf, cellEditReducer } from "./cell-input-state"
import { prefillDraft, priceInputOf } from "./price-block"
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

/** Every cell's type: the body face at 13px, digits aligned. */
const CELL_TEXT = "text-[13px] leading-5 tabular-nums"
const CELL_TRANSITION = "transition-[background-color] duration-150 ease-out"
/**
 * A cell's surface: flat at rest, one step up on hover (the row's own hover is `bgHover`, so the
 * cell takes `bgActive` to show against it), and a cut-out field with a ring while it has focus.
 */
const CELL_SURFACE =
  "hover:bg-background-bgActive focus-within:bg-background hover:focus-within:bg-background focus-within:ring-1 focus-within:ring-ring"

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

const CYCLE_WORD: Readonly<Record<string, string>> = {
  monthly: "month",
  yearly: "year",
  weekly: "week",
  daily: "day",
}

/** One billing or reset period as a word; "cycle" for a cadence without one (the test cadences). */
export function cycleWord(cadence: string | undefined): string {
  return (cadence && CYCLE_WORD[cadence]) || "cycle"
}

const number = new Intl.NumberFormat("en", { maximumFractionDigits: 8 })

/**
 * The text a cell shows at rest: "1,000", or "$0.002" with a currency. Nothing for nothing, and
 * the text itself when it is not a number.
 */
export function formatCellValue(raw: string, currency?: string): string {
  const text = raw.trim()
  if (text === "" || Number.isNaN(Number(text))) return text
  return currency
    ? formatMoney(text, currency, { maximumFractionDigits: 8 })
    : number.format(Number(text))
}

/** A count of units at rest; nothing for none or zero, which the cell says in a word. */
export function formatUnits(raw: string): string {
  return Number(raw) ? formatCellValue(raw) : ""
}

/** The currency's symbol as `formatMoney` writes it: "$", "€", or the code of one without a symbol. */
export function currencySymbol(currency: string): string {
  return formatMoney("0", currency).replace(/[\d\s.,]/g, "")
}

/** The unit for a count; a feature stores it in either number ("call", "images"). */
function unitWord(unit: string, count: number): string {
  const singular = singularUnit(unit)
  return count === 1 ? singular : `${singular}s`
}

/**
 * The unit after a count of a feature's units: plural, singular for exactly one, and the reset
 * period when it differs from the plan's billing ("images / day").
 */
export function unitSuffixOf(
  row: Pick<PlanVersionFeatureDragDrop, "featureType" | "unitOfMeasure" | "resetConfig">,
  planBillingName: string | undefined,
  value: string
): string {
  const unit = unitWord(row.unitOfMeasure ?? "units", Number(value))
  const reset = row.featureType === "usage" ? row.resetConfig?.name : undefined
  return reset && reset !== planBillingName ? `${unit} / ${cycleWord(reset)}` : unit
}

export { tierSummary } from "@unprice/services/pricing"
import { tierSummary } from "@unprice/services/pricing"

/** Prices by dimension in one line: "79 models from the catalog". */
export function dimensionSummary(byDimension: readonly RateRow[]): string {
  const [key = "price"] = new Set(byDimension.flatMap((row) => Object.keys(row.match)))
  const count = byDimension.length
  return `${number.format(count)} ${key}${count === 1 ? "" : "s"} from the catalog`
}

export type SummaryAction = "tiers" | "catalog" | "card"

export type PriceCell =
  | Readonly<{
      kind: "amount"
      shape: Exclude<PricingShape, "graduated">
      amount: string
      /** What follows the amount: "/ call", "/ month", "/ 100 calls". */
      suffix: string
      priced: boolean
      /** "from Nov 5, 2026" when the price shown has not started. */
      scheduled: string | null
    }>
  | Readonly<{
      kind: "summary"
      text: string
      priced: boolean
      action: SummaryAction
    }>

function amountSuffixOf(
  shape: Exclude<PricingShape, "graduated">,
  row: PlanVersionFeatureDragDrop,
  planBillingName: string | undefined
): string {
  const unit = row.unitOfMeasure ?? "units"
  switch (shape) {
    case "flat":
      return `/ ${cycleWord(planBillingName)}`
    case "unit":
      return `/ ${unitWord(unit, 1)}`
    case "package": {
      const size = row.config?.units
      return size ? `/ ${number.format(size)} ${unitWord(unit, size)}` : "/ bundle"
    }
  }
}

/**
 * What the Price cell shows: an amount to type for a fixed, per-unit or bundle price; a summary
 * that opens the sheet for tiers, for prices by dimension, and for a row the decimal form cannot
 * state. A fixed feature with no row edits 0, so committing the cell includes it at $0.
 */
export function priceCellOf(
  row: PlanVersionFeatureDragDrop,
  rows: FeaturePriceRows | undefined,
  currency: string,
  planBillingName: string | undefined,
  catalogPriced = false
): PriceCell {
  const unit = singularUnit(row.unitOfMeasure ?? "units")
  const priced = priceStateOf(rows) !== "unpriced"
  const summary = (
    action: SummaryAction,
    text = describeFeaturePrice(rows, currency, unit)
  ): PriceCell => ({ kind: "summary", text, priced, action })
  const hasDimensions =
    (row.meterConfig?.groupBy?.length ?? 0) > 0 || (rows?.byDimension.length ?? 0) > 0
  if (hasDimensions) {
    return summary(
      "catalog",
      rows?.byDimension.length && catalogPriced ? dimensionSummary(rows.byDimension) : undefined
    )
  }
  const shape = pricingShape({ featureType: row.featureType, usageMode: row.config?.usageMode })
  if (shape === "graduated") {
    const current = rows?.current?.price
    return summary(
      "tiers",
      current?.type === "graduated" ? tierSummary(current, currency, unit) : undefined
    )
  }
  const current = rows?.current ?? rows?.scheduled ?? null
  const prefill = prefillDraft(current, shape)
  if (!prefill || prefill.kind !== "amount") return summary("card")
  return {
    kind: "amount",
    shape,
    amount: prefill.amount,
    suffix: amountSuffixOf(shape, row, planBillingName),
    priced,
    scheduled: rows?.scheduled && !rows.current ? scheduledFrom(rows.scheduled) : null,
  }
}

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
 * One cell that reads as text and edits in place. At rest it shows `text`, or the empty word when
 * there is none. Focus swaps in the raw value with the unit after it; Enter or blur commits and
 * Escape restores. `onCommit` answers what stopped the value, which stays under the cell.
 * At rest, the cell always reads saved props.
 */
export function CellInput({
  value,
  text,
  empty,
  prefix,
  suffix,
  placeholder,
  inputMode = "numeric",
  label,
  disabled,
  problem,
  commitUnchanged = false,
  onCommit,
}: {
  /** The raw text to edit. */
  value: string
  /** What rest shows for `value`; "" for the empty word. */
  text: string
  /** The muted word at rest with nothing to show, such as "No limit". */
  empty: string
  /** The currency symbol before the number while editing. */
  prefix?: string
  /** The muted unit after the number. */
  suffix: string
  /** The hint while editing with nothing typed. */
  placeholder?: string
  inputMode?: "numeric" | "decimal"
  label: string
  disabled?: boolean
  problem: string | null
  /** Commit on blur even when the text is what it was: a fixed feature's 0 prices it. */
  commitUnchanged?: boolean
  onCommit: (text: string) => string | null
}) {
  const [edit, dispatch] = useReducer(cellEditReducer, null)
  const editing = edit !== null
  const [error, setError] = useState<{ value: string; message: string } | null>(null)
  // Escape calls blur before React applies state updates, so the ref suppresses the blur commit.
  const escaped = useRef(false)
  const message = (error?.value === value ? error.message : null) ?? problem
  const shown = edit ? edit.draft : text
  const idle = !editing && text === ""
  const ghost = shown || (editing ? placeholder : empty) || ""

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (event.key === "Escape") {
      event.preventDefault()
      escaped.current = true
      event.currentTarget.blur()
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label
        className={cn(
          "flex h-7 items-center gap-1 rounded px-2",
          CELL_TEXT,
          CELL_TRANSITION,
          disabled ? "cursor-not-allowed" : cn("cursor-text", CELL_SURFACE),
          message && "ring-1 ring-destructive"
        )}
      >
        {editing && prefix && <span>{prefix}</span>}
        <span className="grid min-w-[3ch] max-w-full">
          <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-pre">
            {ghost}
          </span>
          <input
            aria-label={label}
            aria-invalid={message ? true : undefined}
            inputMode={inputMode}
            // One character wide on its own, so the ghost text sets the cell's width, not the
            // input's default 20 characters.
            size={1}
            className={cn(
              "col-start-1 row-start-1 w-full min-w-0 border-0 bg-transparent p-0 outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:text-muted-foreground",
              CELL_TEXT,
              idle && "text-muted-foreground"
            )}
            placeholder={editing ? placeholder : empty}
            value={shown}
            disabled={disabled}
            onFocus={() => dispatch({ type: "focus", value })}
            onChange={(event) => {
              dispatch({ type: "change", value: event.target.value })
              setError(null)
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              dispatch({ type: "blur" })
              if (escaped.current) {
                escaped.current = false
                setError(null)
                return
              }
              const changed = cellCommitOf(edit, value, Boolean(problem) || commitUnchanged)
              if (changed === null) return
              const refused = onCommit(changed)
              setError(refused ? { value, message: refused } : null)
            }}
          />
        </span>
        {!idle && (
          <span className="truncate text-muted-foreground" title={suffix}>
            {suffix}
          </span>
        )}
      </label>
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

/** The kind select, borderless with its chevron on hover, and the details icon that opens the sheet. */
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
              "h-7 min-w-0 flex-1 rounded border-0 px-2 py-0 shadow-none ring-offset-0 focus:ring-offset-0 [&>svg]:size-3.5 [&>svg]:text-muted-foreground [&>svg]:opacity-0 [&>svg]:transition-opacity [&>svg]:duration-150 [&>svg]:ease-out",
              CELL_TEXT,
              CELL_TRANSITION,
              !disabled &&
                "hover:bg-background-bgActive focus:bg-background focus:ring-1 focus:ring-ring hover:focus:bg-background [&:focus>svg]:opacity-100 [&:hover>svg]:opacity-100 [&[data-state=open]>svg]:opacity-100",
              problem && "ring-1 ring-destructive"
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

const SUMMARY_ACTION: Record<SummaryAction, string> = {
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
    const action = SUMMARY_ACTION[cell.action]
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled={disabled}
          onClick={onConfigure}
          className={cn(
            "group/cell relative flex min-h-7 w-full items-center rounded px-2 py-1 text-left",
            CELL_TEXT,
            CELL_TRANSITION,
            disabled
              ? "cursor-not-allowed"
              : "hover:bg-background-bgActive focus-visible:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            !cell.priced && "text-muted-foreground",
            problem && "ring-1 ring-destructive"
          )}
        >
          <span>{cell.priced ? cell.text : action}</span>
          {!disabled && cell.priced && (
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r bg-gradient-to-r from-transparent via-30% via-background-bgActive to-background-bgActive pr-2 pl-8 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover/cell:opacity-100 group-focus-visible/cell:via-background group-focus-visible/cell:to-background group-focus-visible/cell:opacity-100">
              {action}
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
        key={cell.shape}
        value={cell.amount}
        text={cell.priced ? formatCellValue(cell.amount, currency) : ""}
        empty="Set price"
        prefix={currencySymbol(currency)}
        suffix={cell.suffix}
        placeholder={cell.shape === "flat" ? "0" : "0.02"}
        inputMode="decimal"
        label="Price"
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
        <span className="px-2 text-muted-foreground text-xs">{cell.scheduled}</span>
      )}
    </div>
  )
}

/** The Limit or Included cell: a whole number of units, or empty for none. */
export function UnitsCell({
  value,
  label,
  suffix,
  empty,
  decimal = false,
  disabled,
  problem,
  onCommit,
}: {
  value: string
  label: string
  suffix: string
  empty: string
  /** Included units are a decimal string; a limit and a quantity are whole numbers. */
  decimal?: boolean
  disabled?: boolean
  problem: string | null
  onCommit: (value: number | string | null) => void
}) {
  return (
    <CellInput
      value={value}
      text={formatUnits(value)}
      empty={empty}
      suffix={suffix}
      inputMode={decimal ? "decimal" : "numeric"}
      label={label}
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

/** A published version's cell: the fact as the editor shows it at rest, never a disabled control. */
export function ReadOnlyCell({
  text,
  suffix,
  muted,
}: {
  text: string
  suffix?: string
  muted?: boolean
}) {
  return (
    <span
      className={cn("flex items-center gap-1 px-2", CELL_TEXT, muted && "text-muted-foreground")}
    >
      <span>{text}</span>
      {suffix && <span className="text-muted-foreground">{suffix}</span>}
    </span>
  )
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
