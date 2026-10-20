"use client"

import { useQuery } from "@tanstack/react-query"
import {
  type InspectBudgetQuery,
  budgetAmountInputSchema,
  budgetInspectFindSchema,
} from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { RadioGroup, RadioGroupItem } from "@unprice/ui/radio-group"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@unprice/ui/sheet"
import { Skeleton } from "@unprice/ui/skeleton"
import { Bug } from "lucide-react"
import { type ReactNode, useState } from "react"
import { CopyButton } from "~/components/copy-button"
import { formatDate } from "~/lib/dates"
import { useTRPC } from "~/trpc/client"
import { formatBudgetAmount } from "./budget-format"
import { describeOperation } from "./budget-operations"
import { explainDenial } from "./explain-denial"

type Find = NonNullable<InspectBudgetQuery["find"]>

const FIND_BY: { by: Find["by"]; label: string; placeholder: string }[] = [
  { by: "hold", label: "hold id", placeholder: "h_4820" },
  { by: "idempotencyKey", label: "idempotency key", placeholder: "job-1002" },
  { by: "lease", label: "lease key", placeholder: "agent-7" },
]

function toFind(by: Find["by"], value: string) {
  const text = value.trim()
  if (by === "hold") return budgetInspectFindSchema.safeParse({ by, holdId: text })
  if (by === "lease") return budgetInspectFindSchema.safeParse({ by, leaseKey: text })
  return budgetInspectFindSchema.safeParse({ by, idempotencyKey: text })
}

export function BudgetDebugSheet({ id, budgetKey }: { id: string; budgetKey: string }) {
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)
  const [findBy, setFindBy] = useState<Find["by"]>("hold")
  const [findText, setFindText] = useState("")
  const [find, setFind] = useState<Find | null>(null)
  const [probeText, setProbeText] = useState("")
  const [probe, setProbe] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ find?: string; probe?: string }>({})

  const { data: snapshot, error: snapshotError } = useQuery(
    trpc.budgets.inspect.queryOptions({ id }, { enabled: open })
  )
  const {
    data: found,
    error: findError,
    isFetching: finding,
  } = useQuery(
    trpc.budgets.inspect.queryOptions(
      { id, find: find ?? undefined },
      { enabled: open && find !== null }
    )
  )
  const {
    data: probed,
    error: probeError,
    isFetching: probing,
  } = useQuery(
    trpc.budgets.inspect.queryOptions(
      { id, probe: probe ?? undefined },
      { enabled: open && probe !== null }
    )
  )
  const unit = snapshot?.budget.unit ?? ""

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Bug className="mr-1.5 size-3.5" />
        Debug
      </Button>
      <SheetContent className="flex h-[100dvh] max-h-[100dvh] w-full max-w-full flex-col gap-0 overflow-x-hidden p-0 sm:max-w-lg">
        <SheetHeader className="shrink-0 border-border border-b px-4 py-5 pr-12 text-left sm:px-6">
          <SheetTitle className="truncate font-medium font-mono text-base">
            Debug · {budgetKey}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Reads the budget live. Nothing here changes it.
          </SheetDescription>
        </SheetHeader>

        <div className="hide-scrollbar min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          <Section title="Find an operation (last 24 to 25 h)">
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                const parsed = toFind(findBy, findText)
                setProblem((current) => ({
                  ...current,
                  find: parsed.success ? undefined : parsed.error.issues[0]?.message,
                }))
                if (parsed.success) setFind(parsed.data)
              }}
            >
              <RadioGroup
                value={findBy}
                onValueChange={(value) => setFindBy(value as Find["by"])}
                className="flex flex-wrap gap-x-4 gap-y-2"
              >
                {FIND_BY.map((option) => (
                  <div key={option.by} className="flex items-center gap-2">
                    <RadioGroupItem value={option.by} id={`find-${option.by}`} />
                    <Label htmlFor={`find-${option.by}`} className="font-normal text-xs">
                      {option.label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              <div className="flex gap-2">
                <Input
                  aria-label="Operation to find"
                  placeholder={FIND_BY.find((option) => option.by === findBy)?.placeholder}
                  value={findText}
                  onChange={(event) => setFindText(event.target.value)}
                  className="h-8 font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="submit" variant="outline" size="sm" disabled={!findText.trim()}>
                  Find
                </Button>
              </div>
            </form>
            {problem.find ? (
              <Muted>{problem.find}</Muted>
            ) : find === null ? null : finding && !found ? (
              <Skeleton className="h-10" />
            ) : findError ? (
              <Muted>{findError.message}</Muted>
            ) : found?.found ? (
              <FoundOperation operation={found.found} unit={found.budget.unit} />
            ) : found ? (
              <Muted>
                Not found means denied (a denial writes nothing), never sent, or purged.
              </Muted>
            ) : null}
          </Section>

          <Section title="Would it pass now?">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                const parsed = budgetAmountInputSchema.safeParse(probeText.trim())
                setProblem((current) => ({
                  ...current,
                  probe: parsed.success ? undefined : parsed.error.issues[0]?.message,
                }))
                if (parsed.success) setProbe(parsed.data)
              }}
            >
              <Input
                aria-label="Amount to authorize"
                placeholder="70.00"
                inputMode="decimal"
                value={probeText}
                onChange={(event) => setProbeText(event.target.value)}
                className="h-8 font-mono text-xs"
                autoComplete="off"
              />
              <Button type="submit" variant="outline" size="sm" disabled={!probeText.trim()}>
                Check
              </Button>
            </form>
            {problem.probe ? (
              <Muted>{problem.probe}</Muted>
            ) : probe === null ? null : probing && !probed ? (
              <Skeleton className="h-10" />
            ) : probeError ? (
              <Muted>{probeError.message}</Muted>
            ) : probed?.probe ? (
              <Muted>
                {probed.probe.blocked
                  ? explainDenial(probed.probe.blocked, probed.budget.unit)
                  : `Passes now. Authorizing ${formatBudgetAmount(probed.probe.amount, probed.budget.unit)} would succeed.`}
              </Muted>
            ) : null}
          </Section>

          {snapshot ? (
            <>
              <Section title="Counters">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-xs sm:grid-cols-4">
                  {Object.entries(snapshot.budget.operations).map(([verb, count]) => (
                    <div key={verb} className="flex items-baseline justify-between gap-2">
                      <dt className="text-muted-foreground">{verb}</dt>
                      <dd className="tabular-nums">{count.toLocaleString()}</dd>
                    </div>
                  ))}
                </dl>
              </Section>
              <Section title="Scan">
                <dl className="flex flex-col gap-1.5 font-mono text-xs">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted-foreground">examined</dt>
                    <dd className="tabular-nums">
                      {snapshot.expiringNext.examined.toLocaleString()} rows
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted-foreground">listed</dt>
                    <dd className="text-right tabular-nums">
                      {snapshot.expiringNext.rows.length.toLocaleString()} (
                      {formatBudgetAmount(snapshot.listed, unit)} of{" "}
                      {formatBudgetAmount(snapshot.budget.balance.held, unit)} held)
                    </dd>
                  </div>
                </dl>
              </Section>
              <Section title="Raw">
                <div className="relative overflow-x-auto rounded-md border border-border bg-surface-panel">
                  <div className="absolute top-2 right-2">
                    <CopyButton value={JSON.stringify(snapshot, null, 2)} />
                  </div>
                  <pre className="max-h-96 min-w-max overflow-y-auto whitespace-pre p-4 font-mono text-[11px] leading-5">
                    {JSON.stringify(snapshot, null, 2)}
                  </pre>
                </div>
              </Section>
            </>
          ) : (
            <Section title="Counters">
              {snapshotError ? (
                <Muted>{snapshotError.message}</Muted>
              ) : (
                <Skeleton className="h-16" />
              )}
            </Section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function FoundOperation({
  operation,
  unit,
}: {
  operation: Parameters<typeof describeOperation>[0]
  unit: string
}) {
  const line = describeOperation(operation, unit)
  const status = "state" in operation ? operation.state.status : "done"
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-xs">
        {line.kind} {line.id} · {status} · {line.detail} ·{" "}
        {formatDate(operation.createdAt, undefined, "HH:mm:ss")}
        {"expiresAt" in operation
          ? ` · expires ${formatDate(operation.expiresAt, undefined, "HH:mm:ss")}`
          : ""}
      </p>
      <pre className="overflow-x-auto rounded-md border border-border bg-surface-panel p-3 font-mono text-[11px] leading-5">
        {JSON.stringify(operation, null, 2)}
      </pre>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 px-4 py-5 sm:px-6">
      <h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.08em]">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface-panel px-4 py-3 text-muted-foreground text-xs leading-6">
      {children}
    </div>
  )
}
