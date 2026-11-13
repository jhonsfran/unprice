"use client"

import { catalogPolicyFor } from "~/components/pricing/rate-card-format"

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useState } from "react"

import type { Feature, MarginPolicy, PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { cn } from "@unprice/ui/utils"

import type { FeaturePriceRows } from "~/components/pricing/plan-prices"
import { useUpdatePlanFeature } from "~/components/pricing/use-update-plan-feature"
import { useVersionPricing } from "~/components/pricing/use-version-pricing"
import { useActiveFeature, useActivePlanVersion, usePlanFeaturesList } from "~/hooks/use-features"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { DroppableContainer } from "../../_components/droppable"
import { FeatureDialog } from "../../_components/feature-dialog"
import { SortableFeatureRow } from "../../_components/sortable-feature"
import {
  type CellField,
  type CellPatch,
  type CellProblem,
  FeatureCell,
  KindCell,
  PriceCell,
  type PriceCell as PriceCellValue,
  ReadOnlyCell,
  RowMenu,
  UnitsCell,
  formatCellValue,
  formatUnits,
  includedCellOf,
  kindChangeOf,
  kindLabel,
  limitCellOf,
  priceCellOf,
  unitSuffixOf,
} from "./feature-table-cells"

/** The cell a patch came from, so a refusal lands under it. */
function fieldOf(patch: CellPatch): CellField {
  if (patch.price !== undefined) return "price"
  if (patch.limit !== undefined) return "limit"
  if (patch.included !== undefined || patch.defaultQuantity !== undefined) return "included"
  return "kind"
}

/**
 * The version's features as one table: a row per attached feature, whose cells commit one field
 * each with `planVersionFeatures.update`, and whose sheet holds everything a cell cannot.
 */
export function FeatureTable() {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [features, setFeatures] = usePlanFeaturesList()
  const [planVersion] = useActivePlanVersion()
  const [, setActiveFeature] = useActiveFeature()
  const [pendingIds, setPendingIds] = useState<readonly string[]>([])
  const [problems, setProblems] = useState<Readonly<Record<string, CellProblem>>>({})
  const [editing, setEditing] = useState<{ feature: Feature | null; open: boolean }>({
    feature: null,
    open: false,
  })

  // ADR-0008 D2: every price is a row on the version's card, read beside the package it prices.
  const { card, rows } = useVersionPricing(planVersion?.id, planVersion?.currency)
  const currency = planVersion?.currency ?? "USD"
  const update = useUpdatePlanFeature({
    currency,
    onSaved: (planVersionFeature) =>
      setFeatures((list) =>
        list.map((entry) =>
          entry.featureId === planVersionFeature.featureId
            ? { ...entry, ...planVersionFeature }
            : entry
        )
      ),
  })

  const remove = useMutation(
    trpc.planVersionFeatures.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.rateCards.forPlanVersion.pathFilter())
        void queryClient.invalidateQueries({ queryKey: trpc.planVersions.getById.queryKey() })
        router.refresh()
        toastAction("deleted")
      },
    })
  )

  const commit = (row: PlanVersionFeatureDragDrop, patch: CellPatch) => {
    const id = row.id
    if (!id) return
    const field = fieldOf(patch)
    setProblems(({ [id]: _dropped, ...rest }) => rest)
    setPendingIds((ids) => [...ids, id])
    update.mutate(
      { id, planVersionId: row.planVersionId, ...patch },
      {
        onError: (error) =>
          setProblems((current) => ({ ...current, [id]: { field, message: error.message } })),
        onSettled: () => setPendingIds((ids) => ids.filter((pending) => pending !== id)),
      }
    )
  }

  if (!planVersion) return null

  return (
    <>
      <FeatureTableView
        features={features}
        rows={rows}
        currency={currency}
        marginPolicy={card?.card.marginPolicy}
        planBillingName={planVersion.billingConfig.name}
        editable={planVersion.status !== "published"}
        pendingIds={pendingIds}
        problems={problems}
        onCommit={commit}
        onConfigure={(draft) => setActiveFeature(draft)}
        onEditFeature={(feature) => setEditing({ feature, open: true })}
        onRemove={(row) => {
          setActiveFeature((current) => (current?.featureId === row.featureId ? null : current))
          setFeatures((list) => list.filter((entry) => entry.featureId !== row.featureId))
          if (row.id) remove.mutate({ id: row.id })
        }}
      />
      <FeatureDialog
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        defaultValues={editing.feature ?? undefined}
        onUpdated={(feature) =>
          setFeatures((list) =>
            list.map((entry) =>
              entry.featureId === feature.id
                ? { ...entry, feature: { ...entry.feature, ...feature } }
                : entry
            )
          )
        }
      />
    </>
  )
}

const HEAD = "h-9 text-xs"
/** A field column's head sits at the cell's text, which its own padding moves in by 4px. */
const FIELD_HEAD = "h-9 px-3 text-xs"
/** Rows are 44px; the field cells keep 4px so the cell's own surface fills the column. */
const CELL = "h-11 py-1"
const FIELD = "h-11 p-1"

/** The table with fixed data, so a test renders each row state. */
export function FeatureTableView({
  features,
  rows,
  currency,
  marginPolicy,
  planBillingName,
  editable,
  pendingIds,
  problems,
  onCommit,
  onConfigure,
  onEditFeature,
  onRemove,
}: {
  features: readonly PlanVersionFeatureDragDrop[]
  rows: ReadonlyMap<string, FeaturePriceRows>
  marginPolicy?: MarginPolicy
  currency: string
  planBillingName: string | undefined
  editable: boolean
  /** Plan feature ids with an update in flight. */
  pendingIds: readonly string[]
  problems: Readonly<Record<string, CellProblem>>
  onCommit: (row: PlanVersionFeatureDragDrop, patch: CellPatch) => void
  onConfigure: (draft: PlanVersionFeatureDragDrop) => void
  onEditFeature: (feature: Feature) => void
  onRemove: (row: PlanVersionFeatureDragDrop) => void
}) {
  const body = features.map((row) => {
    const cells = (handle: React.ReactNode) => (
      <FeatureRowCells
        row={row}
        priceRows={rows.get(row.feature.slug)}
        catalogPriced={
          marginPolicy ? catalogPolicyFor(marginPolicy, row.feature.slug) !== null : false
        }
        currency={currency}
        planBillingName={planBillingName}
        editable={editable}
        saving={!row.id || pendingIds.includes(row.id)}
        problem={row.id ? (problems[row.id] ?? null) : null}
        handle={handle}
        onCommit={(patch) => onCommit(row, patch)}
        onConfigure={(draft) => onConfigure(draft ?? row)}
        onEditFeature={() => onEditFeature(row.feature)}
        onRemove={() => onRemove(row)}
      />
    )
    return editable ? (
      <SortableFeatureRow key={row.featureId} planFeatureVersion={row} disabled={!row.id}>
        {cells}
      </SortableFeatureRow>
    ) : (
      <TableRow key={row.featureId}>{cells(null)}</TableRow>
    )
  })

  const table = (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={cn(HEAD, "w-10")}>
            <span className="sr-only">Order</span>
          </TableHead>
          <TableHead className={HEAD}>Feature</TableHead>
          <TableHead className={cn(FIELD_HEAD, "w-[112px]")}>Kind</TableHead>
          <TableHead
            className={cn(FIELD_HEAD, "w-[120px]")}
            title="Usage past the limit is refused."
          >
            Limit
          </TableHead>
          <TableHead
            className={cn(FIELD_HEAD, "w-[120px]")}
            title="Units free each period, or the quantity a subscription starts with."
          >
            Included
          </TableHead>
          <TableHead className={cn(FIELD_HEAD, "w-[224px]")}>Price</TableHead>
          <TableHead className={cn(HEAD, "w-10")}>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{body}</TableBody>
    </Table>
  )

  return editable ? (
    <DroppableContainer id="planVersionFeaturesList">
      <SortableContext
        items={features.map((feature) => feature.featureId)}
        strategy={verticalListSortingStrategy}
      >
        {table}
      </SortableContext>
    </DroppableContainer>
  ) : (
    table
  )
}

function FeatureRowCells({
  row,
  priceRows,
  catalogPriced,
  currency,
  planBillingName,
  editable,
  saving,
  problem,
  handle,
  onCommit,
  onConfigure,
  onEditFeature,
  onRemove,
}: {
  row: PlanVersionFeatureDragDrop
  priceRows: FeaturePriceRows | undefined
  catalogPriced: boolean
  currency: string
  planBillingName: string | undefined
  editable: boolean
  saving: boolean
  problem: CellProblem | null
  handle: React.ReactNode
  onCommit: (patch: CellPatch) => void
  onConfigure: (draft?: PlanVersionFeatureDragDrop) => void
  onEditFeature: () => void
  onRemove: () => void
}) {
  const limit = limitCellOf(row)
  const included = includedCellOf(row)
  const price = priceCellOf(row, priceRows, currency, planBillingName, catalogPriced)
  const problemFor = (field: CellField) => (problem?.field === field ? problem.message : null)
  const disabled = !editable || saving
  const units = (value: string) => unitSuffixOf(row, planBillingName, value)

  return (
    <>
      <TableCell className={cn(CELL, "w-10 align-middle")}>
        <div className="flex items-center">{handle}</div>
      </TableCell>
      <TableCell className={CELL}>
        <FeatureCell row={row} planBillingName={planBillingName} saving={saving} />
      </TableCell>
      <TableCell className={FIELD}>
        {editable ? (
          <KindCell
            value={row.featureType}
            disabled={disabled}
            problem={problemFor("kind")}
            onChange={(kind) => {
              const change = kindChangeOf(row, kind)
              if (!change) return
              if ("commit" in change) onCommit(change.commit)
              else onConfigure(change.configure)
            }}
            onConfigure={() => onConfigure()}
          />
        ) : (
          <ReadOnlyCell text={kindLabel(row.featureType)} />
        )}
      </TableCell>
      <TableCell className={FIELD}>
        {limit && editable ? (
          <UnitsCell
            value={limit.value}
            label="Limit"
            suffix={units(limit.value)}
            empty="No limit"
            disabled={disabled}
            problem={problemFor("limit")}
            onCommit={(value) => onCommit({ limit: Number(value ?? 0) })}
          />
        ) : limit ? (
          readOnlyUnits(limit.value, units(limit.value), "No limit")
        ) : null}
      </TableCell>
      <TableCell className={FIELD}>
        {included && editable ? (
          <UnitsCell
            value={included.value}
            label="Included"
            suffix={units(included.value)}
            empty="0"
            decimal={included.field === "included"}
            disabled={disabled}
            problem={problemFor("included")}
            onCommit={(value) =>
              onCommit(
                included.field === "included"
                  ? { included: value === null ? null : String(value) }
                  : { defaultQuantity: Number(value ?? 0) }
              )
            }
          />
        ) : included ? (
          readOnlyUnits(included.value, units(included.value), "0")
        ) : null}
      </TableCell>
      <TableCell className={FIELD}>
        {editable ? (
          <PriceCell
            cell={price}
            currency={currency}
            disabled={disabled}
            problem={problemFor("price")}
            onCommit={(value) => onCommit({ price: value })}
            onConfigure={() => onConfigure()}
          />
        ) : (
          readOnlyPrice(price, currency)
        )}
      </TableCell>
      <TableCell className={cn(CELL, "text-right")}>
        <RowMenu
          title={row.feature.title}
          editable={editable}
          onConfigure={() => onConfigure()}
          onEditFeature={onEditFeature}
          onRemove={onRemove}
        />
      </TableCell>
    </>
  )
}

/** A published version's units: the count with its unit, or the empty word muted. */
function readOnlyUnits(value: string, suffix: string, empty: string) {
  const text = formatUnits(value)
  return text ? <ReadOnlyCell text={text} suffix={suffix} /> : <ReadOnlyCell text={empty} muted />
}

/** A published version's price, as the editor's cell reads at rest. */
function readOnlyPrice(price: PriceCellValue, currency: string) {
  if (!price.priced) return <ReadOnlyCell text="Not priced" muted />
  if (price.kind === "summary") return <ReadOnlyCell text={price.text} />
  return (
    <ReadOnlyCell
      text={formatCellValue(price.amount, currency)}
      suffix={price.scheduled ? `${price.suffix} ${price.scheduled}` : price.suffix}
    />
  )
}
