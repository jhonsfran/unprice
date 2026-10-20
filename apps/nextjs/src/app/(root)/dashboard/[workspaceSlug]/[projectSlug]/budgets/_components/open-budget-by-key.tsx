"use client"

import { useMutation } from "@tanstack/react-query"
import { TRPCClientError } from "@trpc/client"
import { budgetKeyInputSchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { ArrowRight, Loader2, Search } from "lucide-react"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"
import { useTRPC } from "~/trpc/client"

export function OpenBudgetByKey() {
  const trpc = useTRPC()
  const router = useRouter()
  const { workspaceSlug, projectSlug } = useParams<{ workspaceSlug: string; projectSlug: string }>()
  const [key, setKey] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  // the key stays in the mutation body; the page URL carries only the catalog id
  const { mutate, isPending } = useMutation(
    trpc.budgets.openByKey.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: ({ id }) => router.push(`/${workspaceSlug}/${projectSlug}/budgets/${id}`),
      onError: (error) =>
        setProblem(
          error instanceof TRPCClientError && error.data?.code === "NOT_FOUND"
            ? "No budget at this key"
            : error.message
        ),
    })
  )

  return (
    <form
      className="flex w-full flex-col items-end gap-1 md:w-auto"
      onSubmit={(event) => {
        event.preventDefault()
        const parsed = budgetKeyInputSchema.safeParse(key.trim())
        if (!parsed.success) {
          setProblem("Keys use letters, digits and : / _ . @ -")
          return
        }
        setProblem(null)
        mutate({ key: parsed.data })
      }}
    >
      <div className="flex w-full items-center md:w-auto">
        <div className="relative flex-1 md:w-64 md:flex-none">
          <Search
            aria-hidden
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
          />
          <Input
            aria-label="Budget key"
            placeholder="Open by exact key…"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            aria-invalid={problem !== null}
            className="h-8 rounded-r-none pl-8 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="-ml-px h-8 shrink-0 rounded-l-none"
          disabled={isPending || key.trim() === ""}
        >
          {isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ArrowRight className="size-3.5" />
          )}
          <span className="sr-only">Open budget</span>
        </Button>
      </div>
      {problem && (
        <p role="alert" className="text-danger-text text-xs">
          {problem}
        </p>
      )}
    </form>
  )
}
