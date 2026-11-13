"use client"

import { singularUnit } from "@unprice/services/pricing"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RATE_CHANGE_NOTICE_MS, type RateCard, type RateRow } from "@unprice/db/validators"
import { describeRatePrice } from "@unprice/services/pricing"
import type { PricingShape } from "@unprice/services/pricing"
import { Button } from "@unprice/ui/button"
import { Checkbox } from "@unprice/ui/checkbox"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@unprice/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"
import { HelpCircle } from "@unprice/ui/icons"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { RadioGroup, RadioGroupItem } from "@unprice/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import { Check, ChevronsUpDown } from "lucide-react"
import { type ReactNode, useState } from "react"
import { InputWithAddons } from "~/components/input-addons"
import {
  type PriceFields,
  buildRatePrice,
  cardCurrency,
  catalogPolicyFor,
  earliestStart,
  formatMatch,
  markupPercent,
  openRows,
} from "~/components/pricing/rate-card-format"
import { CollapsibleSection } from "~/components/pricing/section-label"
import { TiersEditor } from "~/components/pricing/tiers-editor"
import { type TierDraft, emptyTier } from "~/components/pricing/tiers-model"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import type { FeatureLabel } from "./rate-card-detail"
import { ScheduleField } from "./schedule-field"

const NOTICE_MINUTES = RATE_CHANGE_NOTICE_MS / 60_000

type PublishDraft = {
  open: boolean
  featureSlug: string
  dimensionValue: string
  scope: "every" | "one"
  kind: PricingShape
  amount: string
  per: string
  property: string
  tiers: readonly TierDraft[]
  schedule: boolean
  effectiveFrom: number | null
  closeRowIds: string[]
  isAdvancedOpen: boolean
  isEndOpen: boolean
  problem: string | null
}

function initialDraft(live: boolean): PublishDraft {
  return {
    open: false,
    featureSlug: "",
    dimensionValue: "",
    scope: "every",
    kind: "unit",
    amount: "",
    per: "1",
    property: "",
    tiers: [emptyTier("tier-0")],
    schedule: false,
    effectiveFrom: earliestStart(live, Date.now(), RATE_CHANGE_NOTICE_MS),
    closeRowIds: [],
    isAdvancedOpen: false,
    isEndOpen: false,
    problem: null,
  }
}

const PRICE_KINDS: { value: PricingShape; label: string; description: string }[] = [
  { value: "unit", label: "Per unit", description: "The same price for every unit used." },
  {
    value: "graduated",
    label: "Tiers",
    description: "Each range of units has its own price, like the first 1,000 free.",
  },
  { value: "package", label: "Per bundle", description: "Units are sold in bundles of a size." },
  { value: "flat", label: "Fixed per cycle", description: "One amount every billing cycle." },
]

/** The properties a feature's rows already vary by, and the values each one has. */
export function dimensionsOf(rows: readonly RateRow[], featureSlug: string) {
  const values = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.featureSlug !== featureSlug) continue
    for (const [key, value] of Object.entries(row.match)) {
      const set = values.get(key) ?? new Set<string>()
      set.add(value)
      values.set(key, set)
    }
  }
  return [...values].map(([key, set]) => ({ key, values: [...set].sort() }))
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <HelpCircle className="size-3.5 text-muted-foreground" />
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[280px]">
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Adds one price to a card, for what the feature editor cannot say: one model's own price, a
 * shared card's row, a price that starts later. A price for the same feature and model replaces
 * the open one where it starts; ending other prices at the same time is an advanced choice.
 */
export function PublishRowsDialog({
  card,
  rows,
  live,
  features,
  children,
}: {
  card: RateCard
  rows: readonly RateRow[]
  /** A published version prices with the card, so a change takes the notice. */
  live: boolean
  /** Titles and units of the features the card prices; the catalog's when absent. */
  features?: readonly FeatureLabel[]
  children: ReactNode
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const currency = cardCurrency(card.unit)
  const [draft, setDraft] = useState<PublishDraft>(() => initialDraft(live))
  const {
    open,
    featureSlug,
    dimensionValue,
    scope,
    kind,
    amount,
    per,
    property,
    tiers,
    schedule,
    effectiveFrom,
    closeRowIds,
    isAdvancedOpen,
    isEndOpen,
    problem,
  } = draft
  const patchDraft = (patch: Partial<PublishDraft>) =>
    setDraft((current) => ({ ...current, ...patch }))

  const { data: catalog } = useQuery({
    ...trpc.features.listByActiveProject.queryOptions(),
    enabled: open && features === undefined,
  })
  const options: FeatureLabel[] = features
    ? [...features]
    : (catalog?.features ?? []).map((feature) => ({
        slug: feature.slug,
        title: feature.title,
        unit: feature.unitOfMeasure ?? "units",
      }))
  const feature = options.find((option) => option.slug === featureSlug)
  const unit = singularUnit(feature?.unit ?? "units")
  const dimension = featureSlug ? dimensionsOf(rows, featureSlug)[0] : undefined
  // A plan feature fixes how it is charged and what its meter counts, as a Stripe price fixes its
  // billing scheme: a new price only rates it. Changing those is a feature edit, not a price.
  const fixed = feature?.pricing
  // Every model of a catalog-priced feature follows provider cost plus the markup; a markup change
  // rewrites each model's row, so a price set here by hand would not last. The markup is the lever.
  const catalogPolicy = featureSlug ? catalogPolicyFor(card.marginPolicy, featureSlug) : null
  const priceKind: PricingShape = fixed ? fixed.shape : kind
  const priceProperty = fixed ? (fixed.property ?? "") : property
  // Model rates read per million tokens, so a dimensioned feature keeps the "per" field.
  const showPer =
    priceKind === "unit" ? !fixed || Boolean(dimension) : priceKind === "package" && !fixed
  const pricePer = priceKind === "package" && fixed ? String(fixed.size ?? 1) : per
  const match: Record<string, string> =
    dimension && scope === "one" && dimensionValue.trim()
      ? { [dimension.key]: dimensionValue.trim() }
      : {}
  const matchKey = formatMatch(match)
  const featureOpenRows = openRows(rows).filter((row) => row.featureSlug === featureSlug)
  const replaces = featureOpenRows.find((row) => formatMatch(row.match) === matchKey)
  const others = featureOpenRows.filter((row) => row.id !== replaces?.id)
  // A model priced per token kind has several rates; this form writes one.
  const replacedRates =
    replaces?.price.type === "unit" && replaces.price.components.length > 1
      ? replaces.price.components.map((component) => component.property ?? "event")
      : null

  const reset = () => setDraft(initialDraft(live))

  const { mutate, isPending } = useMutation(
    trpc.rateCards.publishRows.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: ({ inserted, closed, unchanged }) => {
        toast.success(
          inserted.length === 0
            ? `Nothing changed (${unchanged} unchanged)`
            : closed.length > 0
              ? `Price added, replacing ${closed.length}`
              : "Price added"
        )
        patchDraft({ open: false })
        void queryClient.invalidateQueries(trpc.rateCards.get.queryFilter({ id: card.id }))
        void queryClient.invalidateQueries(trpc.rateCards.forPlanVersion.pathFilter())
      },
      onError: (error) => patchDraft({ problem: error.message }),
    })
  )

  const submit = () => {
    patchDraft({ problem: null })
    if (dimension && scope === "one" && !dimensionValue.trim()) {
      patchDraft({
        problem: `Name the ${dimension.key} this price is for, or pick every ${dimension.key}.`,
      })
      return
    }
    const fields: PriceFields = {
      shape: priceKind,
      amount,
      per: showPer || priceKind === "package" ? pricePer : "1",
      property: priceProperty,
      tiers,
    }
    const built = buildRatePrice(fields)
    if (!built.ok) {
      patchDraft({ problem: built.message })
      return
    }
    mutate({
      cardId: card.id,
      rows: [{ featureSlug, match, price: built.price, cost: null }],
      ...(schedule && effectiveFrom !== null ? { effectiveFrom } : {}),
      ...(closeRowIds.length > 0 ? { closeRowIds } : {}),
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) reset()
        patchDraft({ open: next })
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Add a price</DialogTitle>
          <DialogDescription>
            {live
              ? `Customers already pay from this price list, so a new price starts at least ${NOTICE_MINUTES} minutes from now.`
              : "No customer pays from this price list yet, so a new price starts as soon as you add it."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label>Feature</Label>
            <Select
              value={featureSlug}
              onValueChange={(slug) => {
                patchDraft({
                  featureSlug: slug,
                  scope: "every",
                  dimensionValue: "",
                  closeRowIds: [],
                })
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a feature" />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.slug} value={option.slug}>
                    {option.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fixed && feature?.charge && !catalogPolicy && (
              <p className="text-muted-foreground text-xs">
                {feature.charge}. That is set on the feature; edit it in the Features tab to charge
                it another way.
              </p>
            )}
          </div>

          {catalogPolicy ? (
            <div className="flex flex-col gap-1.5 rounded-md bg-background-bgSubtle px-3 py-2.5 text-xs">
              <p className="font-medium">
                {feature?.title ?? featureSlug} is priced from the model catalog.
              </p>
              <p className="text-muted-foreground">
                Each model costs its provider price from models.dev plus a{" "}
                {markupPercent(catalogPolicy.markup)}% markup, per million tokens of each kind
                (input, output, cache). To reprice every model, change the markup next to the model
                prices.
              </p>
            </div>
          ) : (
            <>
              {dimension && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1">
                    <Label>Applies to</Label>
                    <Hint>
                      This feature is priced per {dimension.key}. A price for one {dimension.key}{" "}
                      overrides the price every other {dimension.key} gets.
                    </Hint>
                  </div>
                  <RadioGroup
                    value={scope}
                    onValueChange={(value) => patchDraft({ scope: value as "every" | "one" })}
                    className="grid-cols-2"
                  >
                    {(["every", "one"] as const).map((option) => (
                      <Label
                        key={option}
                        htmlFor={`scope-${option}`}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 font-normal text-sm transition-colors",
                          scope === option
                            ? "border-primary bg-background-bgHover"
                            : "hover:bg-background-bgSubtle"
                        )}
                      >
                        <RadioGroupItem id={`scope-${option}`} value={option} />
                        {option === "every" ? `Every ${dimension.key}` : `One ${dimension.key}`}
                      </Label>
                    ))}
                  </RadioGroup>
                  {scope === "one" && (
                    <ValuePicker
                      name={dimension.key}
                      values={dimension.values}
                      value={dimensionValue}
                      onChange={(dimensionValue) => patchDraft({ dimensionValue })}
                    />
                  )}
                </div>
              )}

              {!fixed && (
                <div className="flex flex-col gap-1.5">
                  <Label>How it's charged</Label>
                  <Select
                    value={kind}
                    onValueChange={(value) => patchDraft({ kind: value as PricingShape })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRICE_KINDS.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          description={option.description}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {priceKind === "graduated" ? (
                <TiersEditor
                  tiers={tiers}
                  currency={currency}
                  unit={unit}
                  onChange={(tiers) => patchDraft({ tiers })}
                />
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="price-amount">
                      {priceKind === "flat"
                        ? "Amount"
                        : priceKind === "package"
                          ? `Price per bundle${fixed ? ` of ${pricePer}` : ""}`
                          : showPer
                            ? "Price"
                            : `Price per ${unit}`}
                    </Label>
                    <InputWithAddons
                      id="price-amount"
                      inputMode="decimal"
                      className="font-mono tabular-nums"
                      leading={currency}
                      trailing={priceKind === "flat" ? "cycle" : undefined}
                      value={amount}
                      onChange={(event) => patchDraft({ amount: event.target.value })}
                      placeholder={priceKind === "flat" ? "49" : "0.02"}
                      required
                    />
                  </div>
                  {showPer && (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-1">
                        <Label htmlFor="price-per">
                          {priceKind === "package" ? "Bundle of" : "Per"}
                        </Label>
                        <Hint>
                          {priceKind === "package"
                            ? `How many ${unit}s one bundle holds; a started bundle is charged whole.`
                            : `How many ${unit}s the price is for, such as 1,000,000 for a price per million tokens.`}
                        </Hint>
                      </div>
                      <InputWithAddons
                        id="price-per"
                        inputMode="numeric"
                        className="font-mono tabular-nums"
                        trailing={`${unit}s`}
                        value={per}
                        onChange={(event) => patchDraft({ per: event.target.value })}
                      />
                    </div>
                  )}
                </div>
              )}

              {featureSlug && (
                <div className="flex flex-col gap-1.5 rounded-md bg-background-bgSubtle px-3 py-2 text-muted-foreground text-xs">
                  {replaces && replacedRates ? (
                    <>
                      <p>
                        Replaces the current price of {feature?.title ?? featureSlug}
                        {matchKey !== "Default" ? ` (${matchKey})` : ""}, which has{" "}
                        {replacedRates.length} rates: {replacedRates.join(", ")}.
                      </p>
                      <p className="text-warning">
                        This form sets one rate, so the others stop applying. To reprice every model
                        from its provider cost, use Change markup on the price list instead.
                      </p>
                    </>
                  ) : replaces ? (
                    <p>
                      Replaces the current price{" "}
                      <span className="font-mono text-foreground">
                        {describeRatePrice(replaces.price, currency, unit)}
                      </span>{" "}
                      for {feature?.title ?? featureSlug}
                      {matchKey !== "Default" ? ` (${matchKey})` : ""} when it starts.
                    </p>
                  ) : (
                    <p>
                      {feature?.title ?? featureSlug}
                      {matchKey !== "Default" ? ` (${matchKey})` : ""} has no price yet; this is its
                      first.
                    </p>
                  )}
                </div>
              )}

              <ScheduleField
                id="publish-from"
                label="Starts on"
                schedule={schedule}
                onScheduleChange={(schedule) => patchDraft({ schedule })}
                value={effectiveFrom}
                onChange={(effectiveFrom) => patchDraft({ effectiveFrom })}
              />

              {!fixed && priceKind !== "flat" && (
                <CollapsibleSection
                  label="Advanced: count a number from the event"
                  summary={property.trim() ? property.trim() : "one unit per event"}
                  open={isAdvancedOpen}
                  onOpenChange={(isAdvancedOpen) => patchDraft({ isAdvancedOpen })}
                >
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1">
                      <Label htmlFor="price-property">Event property</Label>
                      <Hint>
                        By default each event counts as one {unit}. Name a numeric property, such as
                        input_tokens, to charge for the number it carries instead.
                      </Hint>
                    </div>
                    <Input
                      id="price-property"
                      className="font-mono text-xs"
                      value={property}
                      onChange={(event) => patchDraft({ property: event.target.value })}
                      placeholder="input_tokens"
                    />
                  </div>
                </CollapsibleSection>
              )}

              {others.length > 0 && (
                <CollapsibleSection
                  label="Advanced: end other prices at the same time"
                  summary={closeRowIds.length > 0 ? `${closeRowIds.length} selected` : "none"}
                  open={isEndOpen}
                  onOpenChange={(isEndOpen) => patchDraft({ isEndOpen })}
                >
                  <div className="flex flex-col gap-2">
                    <p className="text-muted-foreground text-xs">
                      For when this price takes over from several, such as one price for every model
                      replacing per-model prices.
                    </p>
                    <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
                      {others.map((row) => (
                        <div key={row.id} className="flex items-center gap-2 text-xs">
                          <Checkbox
                            id={`close-${row.id}`}
                            checked={closeRowIds.includes(row.id)}
                            onCheckedChange={(checked) =>
                              setDraft((current) => ({
                                ...current,
                                closeRowIds:
                                  checked === true
                                    ? [...current.closeRowIds, row.id]
                                    : current.closeRowIds.filter((rowId) => rowId !== row.id),
                              }))
                            }
                          />
                          <Label htmlFor={`close-${row.id}`} className="font-normal text-xs">
                            <span className="font-mono">{formatMatch(row.match)}</span>{" "}
                            <span className="text-muted-foreground">
                              {describeRatePrice(row.price, currency, unit)}
                            </span>
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                </CollapsibleSection>
              )}
            </>
          )}

          {problem && <p className="text-destructive text-sm">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => patchDraft({ open: false })}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                isPending ||
                !featureSlug ||
                catalogPolicy !== null ||
                (schedule && effectiveFrom === null)
              }
            >
              Add price
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One value of a dimension, picked from the values the card already prices or typed new: the
 * dashboard's Command combobox in place of a browser datalist.
 */
function ValuePicker({
  name,
  values,
  value,
  onChange,
}: {
  name: string
  values: readonly string[]
  value: string
  onChange: (value: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState("")
  const typed = search.trim()

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={name}
          className="h-9 w-full justify-between font-mono font-normal text-xs"
        >
          {value || <span className="font-sans text-muted-foreground">Pick a {name}</span>}
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput
            placeholder={`Search ${values.length} ${name}s or type a new one`}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No {name} matches.</CommandEmpty>
            <CommandGroup>
              {values.map((option) => (
                <CommandItem
                  key={option}
                  value={option}
                  className="font-mono text-xs"
                  onSelect={() => {
                    onChange(option)
                    setIsOpen(false)
                  }}
                >
                  <Check
                    className={cn("mr-2 size-3.5", option === value ? "opacity-100" : "opacity-0")}
                  />
                  {option}
                </CommandItem>
              ))}
            </CommandGroup>
            {typed && !values.includes(typed) && (
              <CommandGroup>
                <CommandItem
                  value={`new:${typed}`}
                  onSelect={() => {
                    onChange(typed)
                    setIsOpen(false)
                  }}
                >
                  Use “<span className="font-mono">{typed}</span>”
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
