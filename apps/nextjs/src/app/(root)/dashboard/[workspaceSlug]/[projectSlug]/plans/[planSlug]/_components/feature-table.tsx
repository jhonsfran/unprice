"use client"

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useState } from "react"

import type { Feature, PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { cn } from "@unprice/ui/utils"

import { useActiveFeature, useActivePlanVersion, usePlanFeaturesList } from "~/hooks/use-features"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { DroppableContainer } from "../../_components/droppable"
import { FeatureDialog } from "../../_components/feature-dialog"
import {
  type FeaturePriceRows,
  describeFeaturePrice,
  rowsByFeature,
  withDefaultRow,
} from "../../_components/plan-prices"
import { SortableFeatureRow } from "../../_components/sortable-feature"
import {
  type CellField,
  type CellPatch,
  type CellProblem,
  FeatureCell,
  KindCell,
  PriceCell,
  ReadOnlyCell,
  RowMenu,
  UnitsCell,
  formatUnits,
  includedCellOf,
  kindChangeOf,
  kindLabel,
  limitCellOf,
  priceCellOf,
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
  const { data: pricing, dataUpdatedAt } = useQuery({
    ...trpc.rateCards.forPlanVersion.queryOptions({ planVersionId: planVersion?.id ?? "" }),
    enabled: Boolean(planVersion),
  })
  const currency = planVersion?.currency ?? "USD"
  const card = pricing?.cards.find((entry) => entry.currency === currency)
  const rows = rowsByFeature(card?.rows ?? [], dataUpdatedAt)

  const update = useMutation(
    trpc.planVersionFeatures.update.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: ({ planVersionFeature, row }, variables) => {
        setFeatures((list) =>
          list.map((entry) =>
            entry.featureId === planVersionFeature.featureId
              ? { ...entry, ...planVersionFeature }
              : entry
          )
        )
        if (variables.price !== undefined && planVersion) {
          // The answered row goes into the pricing cache first, so the cell and the checklist
          // show the new price before the refetch lands.
          queryClient.setQueryData(
            trpc.rateCards.forPlanVersion.queryKey({ planVersionId: planVersion.id }),
            (cached) =>
              cached
                ? {
                    cards: withDefaultRow(
                      cached.cards,
                      planVersion.currency,
                      planVersionFeature.feature.slug,
                      row
                    ),
                  }
                : cached
          )
        }
        void queryClient.invalidateQueries(trpc.rateCards.forPlanVersion.pathFilter())
        void queryClient.invalidateQueries({ queryKey: trpc.planVersions.getById.queryKey() })
        router.refresh()
      },
    })
  )

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

/** The table with fixed data, so a test renders each row state. */
export function FeatureTableView({
  features,
  rows,
  currency,
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
          <TableHead className={cn(HEAD, "w-[140px]")}>Kind</TableHead>
          <TableHead className={cn(HEAD, "w-[104px]")} title="Usage past the limit is refused.">
            Limit
          </TableHead>
          <TableHead
            className={cn(HEAD, "w-[104px]")}
            title="Units free each period, or the quantity a subscription starts with."
          >
            Included
          </TableHead>
          <TableHead className={cn(HEAD, "w-[176px]")}>Price</TableHead>
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
  const unit = (row.unitOfMeasure ?? "units").replace(/s$/, "")
  const limit = limitCellOf(row)
  const included = includedCellOf(row)
  const price = priceCellOf(row, priceRows, currency)
  const problemFor = (field: CellField) => (problem?.field === field ? problem.message : null)
  const disabled = !editable || saving

  return (
    <>
      <TableCell className="w-10 py-1.5 align-middle">
        <div className="flex items-center">{handle}</div>
      </TableCell>
      <TableCell className="py-1.5">
        <FeatureCell row={row} planBillingName={planBillingName} saving={saving} />
      </TableCell>
      <TableCell className="py-1.5">
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
          <ReadOnlyCell>{kindLabel(row.featureType)}</ReadOnlyCell>
        )}
      </TableCell>
      <TableCell className="py-1.5">
        {limit && editable ? (
          <UnitsCell
            value={limit.value}
            label="Limit"
            unit={unit}
            disabled={disabled}
            problem={problemFor("limit")}
            onCommit={(value) => onCommit({ limit: Number(value ?? 0) })}
          />
        ) : limit ? (
          <ReadOnlyCell muted={!row.limit}>{formatUnits(row.limit, "no limit")}</ReadOnlyCell>
        ) : null}
      </TableCell>
      <TableCell className="py-1.5">
        {included && editable ? (
          <UnitsCell
            value={included.value}
            label="Included"
            unit={unit}
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
          <ReadOnlyCell muted={!Number(included.value)}>
            {formatUnits(included.value, "0")}
          </ReadOnlyCell>
        ) : null}
      </TableCell>
      <TableCell className="py-1.5">
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
          <ReadOnlyCell muted={!price.priced}>
            {price.priced ? describeFeaturePrice(priceRows, currency, unit) : "Not priced"}
          </ReadOnlyCell>
        )}
      </TableCell>
      <TableCell className="py-1.5 text-right">
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
