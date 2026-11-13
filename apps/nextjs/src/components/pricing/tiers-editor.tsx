"use client"

import { tierRanges } from "@unprice/services/pricing"
import { Button } from "@unprice/ui/button"
import { Plus, X } from "lucide-react"
import { InputWithAddons } from "~/components/input-addons"

import { type TierDraft, emptyTier } from "./tiers-model"

function title(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Graduated tiers: each row ends at "up to" units; the last row is open-ended. */
export function TiersEditor({
  tiers,
  currency,
  unit,
  onChange,
}: {
  tiers: readonly TierDraft[]
  currency: string
  unit: string
  onChange: (tiers: readonly TierDraft[]) => void
}) {
  const update = (index: number, patch: Partial<TierDraft>) =>
    onChange(tiers.map((tier, at) => (at === index ? { ...tier, ...patch } : tier)))
  const ranges = tierRanges(tiers.map((tier) => ({ upTo: Number(tier.upTo) || null })))

  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs">
        Each tier prices only the {unit}s inside it. Add a tier to charge differently past a
        threshold.
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_28px] gap-2 text-muted-foreground text-xs">
        <span>{title(unit)}s</span>
        <span>Price per {unit}</span>
        <span>Plus a flat fee</span>
        <span />
      </div>
      {tiers.map((tier, index) => {
        const last = index === tiers.length - 1
        const from = ranges[index]?.from ?? 1
        return (
          <div
            key={tier.key}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_28px] items-center gap-2"
          >
            {last ? (
              <span className="flex h-9 items-center rounded-md border border-dashed px-3 font-mono text-muted-foreground text-xs tabular-nums">
                {from} and above
              </span>
            ) : (
              <InputWithAddons
                inputMode="numeric"
                aria-label={`Tier ${index + 1} ends at`}
                className="font-mono text-xs tabular-nums"
                leading={`${from} to`}
                value={tier.upTo}
                onChange={(event) => update(index, { upTo: event.target.value })}
              />
            )}
            <InputWithAddons
              inputMode="decimal"
              aria-label={`Tier ${index + 1} unit price`}
              className="font-mono text-xs tabular-nums"
              leading={currency}
              placeholder="0.02"
              value={tier.rate}
              onChange={(event) => update(index, { rate: event.target.value })}
            />
            <InputWithAddons
              inputMode="decimal"
              aria-label={`Tier ${index + 1} flat fee`}
              className="font-mono text-xs tabular-nums"
              leading={currency}
              value={tier.flat}
              onChange={(event) => update(index, { flat: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={tiers.length === 1}
              onClick={() => onChange(tiers.filter((_, at) => at !== index))}
            >
              <X className="size-3.5" />
              <span className="sr-only">Remove tier {index + 1}</span>
            </Button>
          </div>
        )
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() =>
          onChange([...tiers.slice(0, -1), emptyTier(`tier-${Date.now()}`), ...tiers.slice(-1)])
        }
      >
        <Plus className="mr-1 size-3" />
        Add tier
      </Button>
    </div>
  )
}
