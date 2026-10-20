"use client"

import { useMutation } from "@tanstack/react-query"
import { TRPCClientError } from "@trpc/client"
import { budgetKeyInputSchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { Loader2 } from "lucide-react"
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
      className="flex flex-col items-end gap-1"
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
      <div className="flex items-center gap-2">
        <Input
          aria-label="Budget key"
          placeholder="customer:acme"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          aria-invalid={problem !== null}
          className="h-8 w-56 font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" variant="outline" size="sm" disabled={isPending || key.trim() === ""}>
          {isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          Open by key
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
