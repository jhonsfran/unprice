"use client"

import { useMutation } from "@tanstack/react-query"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@unprice/ui/dialog"
import { cn } from "@unprice/ui/utils"
import { Ban, Check, FlaskConical, Loader2 } from "lucide-react"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"
import { Term } from "~/components/budgets/budget-terms"
import { useTRPC } from "~/trpc/client"

type TestBudgetResult = RouterOutputs["budgets"]["createTestBudget"]

function Decision({
  kind,
  amount,
  remaining,
  detail,
}: {
  kind: "allowed" | "denied"
  amount: string
  remaining: string | null
  detail: string
}) {
  const isAllowed = kind === "allowed"
  const Icon = isAllowed ? Check : Ban
  return (
    <li className="flex items-start gap-3 rounded-md border p-3">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-sm text-white",
          isAllowed ? "bg-success-solid" : "bg-danger-solid"
        )}
      >
        <Icon aria-hidden className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-medium text-sm">
            {isAllowed ? "Allowed" : "Denied"} · spend ${amount}
          </p>
          <p
            className={cn(
              "whitespace-nowrap font-mono text-[11px]",
              isAllowed ? "text-success-text" : "text-danger-text"
            )}
          >
            {isAllowed ? "200 · charged" : "402 · BUDGET_EXCEEDED"}
          </p>
        </div>
        <p className="text-muted-foreground text-xs leading-5">{detail}</p>
        {remaining !== null && (
          <p className="font-mono text-[11px] text-muted-foreground">remaining ${remaining}</p>
        )}
      </div>
    </li>
  )
}

/**
 * The empty Budgets page's "Create a test budget": one click creates a sandbox budget and runs an
 * allowed and a denied spend against it, so the hard cap is visible before any code is written.
 */
export function TestBudget() {
  const trpc = useTRPC()
  const router = useRouter()
  const { workspaceSlug, projectSlug } = useParams<{ workspaceSlug: string; projectSlug: string }>()
  const [result, setResult] = useState<TestBudgetResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const createTestBudget = useMutation(
    trpc.budgets.createTestBudget.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: (data) => {
        setProblem(null)
        setResult(data)
      },
      onError: (error) => setProblem(error.message),
    })
  )
  const openByKey = useMutation(
    trpc.budgets.openByKey.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: ({ id }) => router.push(`/${workspaceSlug}/${projectSlug}/budgets/${id}`),
      onError: () => {
        setResult(null)
        router.refresh()
      },
    })
  )

  const close = () => {
    setResult(null)
    // the catalog row lands in the background; a refresh lists the new budget
    router.refresh()
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={createTestBudget.isPending}
        onClick={() => createTestBudget.mutate({})}
      >
        {createTestBudget.isPending ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <FlaskConical aria-hidden className="size-3.5" />
        )}
        {createTestBudget.isPending ? "Creating test budget…" : "Create a test budget"}
      </Button>
      <p className="max-w-sm text-center text-muted-foreground text-xs leading-5">
        A sandbox budget at the <Term term="budget key" /> <code>sandbox:test-budget</code> with a
        $10 daily cap. No code, no card.
      </p>
      {problem && (
        <p role="alert" className="text-danger-text text-xs">
          {problem}
        </p>
      )}

      <Dialog open={result !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-lg">
          {result && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <DialogTitle>Test budget created</DialogTitle>
                  <Badge variant="warning">sandbox · test</Badge>
                </div>
                <DialogDescription>
                  <code>{result.key}</code> has a hard cap of ${result.cap} per {result.window}. We
                  sent two spends to it through the API with a runtime key, as your code would.
                </DialogDescription>
              </DialogHeader>
              <ol className="flex flex-col gap-2">
                <Decision
                  kind="allowed"
                  amount={result.allowed.amount}
                  remaining={result.allowed.remaining}
                  detail={`It fits under the $${result.cap} cap, so it was charged.`}
                />
                <Decision
                  kind="denied"
                  amount={result.denied.amount}
                  remaining={result.denied.remaining}
                  detail="It would cross the cap, so the API refused it before any work ran. Nothing was charged."
                />
              </ol>
              <p className="text-muted-foreground text-xs leading-5">
                This is a test budget for trying the cap. Running it again today replays the same
                two spends; the cap resets daily.
              </p>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>
                  Close
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={openByKey.isPending}
                  onClick={() => openByKey.mutate({ key: result.key })}
                >
                  {openByKey.isPending ? "Opening…" : "Open test budget"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
