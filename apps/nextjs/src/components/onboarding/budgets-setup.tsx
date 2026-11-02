"use client"

import { useMutation } from "@tanstack/react-query"
import { DOCS_DOMAIN } from "@unprice/config"
import { Button, buttonVariants } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { LedgerRow } from "@unprice/ui/station"
import { useRouter } from "next/navigation"
import { type FormEvent, useState } from "react"

import { updateContextCookies } from "~/actions/update-context-cookies"
import { Term, TermList } from "~/components/budgets/budget-terms"
import { budgetsTwoCalls } from "~/components/landing/budgets-snippets"
import { CodePanel, InstallCommand } from "~/components/landing/code-panel"
import { SuperLink } from "~/components/super-link"
import { useTRPC } from "~/trpc/client"
import { OnboardingFrame, type OnboardingMoment } from "./onboarding-frame"
import { RevealedKey } from "./revealed-key"

// The Budgets setup: what a visitor from /budgets needs before the first call, and nothing
// else. Budgets and API keys live in a project, so the moments are a project, a runtime key,
// and the two calls. No plan, Sandbox, or payment provider: those belong to the billing
// onboarding, which stays the default for every other signup.
//
// The project slug rides in the URL (`?project=`), so a reload resumes at the key instead of
// creating a second project. The new key is shown once, in its own box on the key step with a
// copy button, and the builder moves on only after seeing it. The code on the last step masks
// it, and "Copy code" copies the snippet with the real key so it runs as pasted.

type Step =
  | { id: "project" }
  | { id: "key"; projectSlug: string; apiKey: string | null }
  | { id: "call"; projectSlug: string; apiKey: string }

const MOMENTS: Record<Step["id"], OnboardingMoment> = {
  project: {
    label: "Project",
    setup: "Create a",
    operative: "project.",
    sub: "Budgets and API keys live in a project. Name it after the product your agents run in.",
  },
  key: {
    label: "Runtime key",
    setup: "Create a",
    operative: "runtime key.",
    sub: "Your code spends with this key. It can create a budget and tighten it, but it cannot raise a cap.",
  },
  call: {
    label: "Two calls",
    setup: "Wrap",
    operative: "one call.",
    sub: "Install the package, set a cap, and wrap the call your agent already makes.",
  },
}

const PANEL = "grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]"

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed. Try again."

const maskKey = (key: string) => `${key.slice(0, 13)}${"•".repeat(16)}`

/** What the step is about to create, as receipt rows, so the panel shows the state it makes. */
function Preview({ title, rows }: { title: string; rows: Array<{ label: string; fact: string }> }) {
  return (
    <aside className="flex h-fit flex-col rounded-md border border-background-border bg-background-bgSubtle p-4">
      <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
        {title}
      </span>
      <div className="mt-3 flex flex-col">
        {rows.map((row) => (
          <LedgerRow
            key={row.label}
            label={row.label}
            variant="ghost"
            fact={row.fact}
            factClassName="truncate"
          />
        ))}
      </div>
    </aside>
  )
}

function StepError({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p role="alert" className="text-danger-text text-sm">
      {error}
    </p>
  )
}

function ProjectStep({ workspaceSlug }: { workspaceSlug: string }) {
  const trpc = useTRPC()
  const router = useRouter()
  const [name, setName] = useState("Budgets")
  const [error, setError] = useState<string | null>(null)
  const createProject = useMutation(trpc.projects.create.mutationOptions())

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    try {
      const { project } = await createProject.mutateAsync({
        name: name.trim() || "Budgets",
        defaultCurrency: "USD",
        timezone: "UTC",
      })
      await updateContextCookies(workspaceSlug, project.slug)
      router.replace(`?${new URLSearchParams({ project: project.slug })}`)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <>
      <div className={PANEL}>
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="budgets-project-name">Project name</Label>
            <p className="text-background-text text-xs leading-5">
              Shown in the dashboard. You can rename it later.
            </p>
            <Input
              id="budgets-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            className="w-fit"
            disabled={createProject.isPending}
          >
            {createProject.isPending ? "Creating project…" : "Create project"}
          </Button>
        </form>
        <Preview
          title="Project"
          rows={[
            { label: "name", fact: name.trim() || "Budgets" },
            { label: "holds", fact: "budgets · API keys" },
            { label: "currency", fact: "USD" },
            { label: "timezone", fact: "UTC" },
          ]}
        />
      </div>
      <StepError error={error} />
    </>
  )
}

function KeyStep({
  workspaceSlug,
  projectSlug,
  apiKey,
  onKey,
  onContinue,
}: {
  workspaceSlug: string
  projectSlug: string
  apiKey: string | null
  onKey: (key: string) => void
  onContinue: () => void
}) {
  const trpc = useTRPC()
  const [error, setError] = useState<string | null>(null)
  const createKey = useMutation(trpc.apikeys.create.mutationOptions())

  const onCreate = async () => {
    setError(null)
    try {
      const { apikey } = await createKey.mutateAsync({
        name: "Budgets",
        type: "runtime",
        expiresAt: null,
        defaultCustomerId: null,
        workspaceSlug,
        projectSlug,
      })
      onKey(apikey.key)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <>
      <div className={PANEL}>
        <div className="flex flex-col gap-5">
          {/* The secret is shown once and lives only on this page, so a reload before copying it
              means a new key. Say so, and say where the unused one is revoked. */}
          <p className="text-background-textContrast text-sm leading-6">
            A <Term term="runtime key" /> is the key your code spends with. It is shown once, right
            here after you create it. Each click creates a new key; revoke one you never copied in
            the project's API keys.
          </p>
          {apiKey ? (
            <RevealedKey apiKey={apiKey} onContinue={onContinue} />
          ) : (
            <Button
              type="button"
              variant="primary"
              className="w-fit"
              disabled={createKey.isPending}
              onClick={onCreate}
            >
              {createKey.isPending ? "Creating key…" : "Create runtime key"}
            </Button>
          )}
          <p className="text-background-text text-xs leading-5">
            Raising a cap needs a <Term term="config key" />. Create one later in the project's API
            keys, and keep it out of the environment that spends.
          </p>
        </div>
        <Preview
          title="Runtime key"
          rows={[
            { label: "project", fact: projectSlug },
            { label: "type", fact: "runtime" },
            { label: "spends", fact: "authorize · charge · record" },
            { label: "raise a cap", fact: "config key only" },
          ]}
        />
      </div>
      <StepError error={error} />
    </>
  )
}

function CallStep({
  workspaceSlug,
  projectSlug,
  apiKey,
}: {
  workspaceSlug: string
  projectSlug: string
  apiKey: string
}) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-background-text text-sm">
        The code below shows your runtime key masked. <strong>Copy code</strong> copies it with the
        real key filled in, so it runs as pasted.
      </p>

      <InstallCommand className="w-fit" />

      <CodePanel
        filename="agent.ts"
        code={budgetsTwoCalls(maskKey(apiKey))}
        copyCode={budgetsTwoCalls(apiKey)}
        copyLabel="Copy code"
        className="rounded-md bg-surface-raised"
      />

      <TermList
        terms={["budget key", "estimate", "actual", "lease"]}
        className="rounded-md border border-background-border p-4"
      />

      <div className="flex flex-wrap items-center gap-3">
        <a
          href={`${DOCS_DOMAIN}budgets/quickstart`}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "primary" })}
        >
          Read the quickstart
        </a>
        <SuperLink
          href={`/${workspaceSlug}/${projectSlug}/apikeys`}
          className={buttonVariants({ variant: "outline" })}
        >
          Go to API keys
        </SuperLink>
      </div>
    </div>
  )
}

export function BudgetsSetup({
  workspaceSlug,
  projectSlug,
}: {
  workspaceSlug: string
  /** The project created on the first step, read from `?project=`. */
  projectSlug: string | null
}) {
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [keySaved, setKeySaved] = useState(false)
  const step: Step = !projectSlug
    ? { id: "project" }
    : apiKey && keySaved
      ? { id: "call", projectSlug, apiKey }
      : { id: "key", projectSlug, apiKey }

  return (
    <OnboardingFrame
      eyebrow="budgets · setup"
      label="Budgets setup"
      moments={MOMENTS}
      active={step.id}
    >
      <div className="flex flex-col gap-6 p-6 sm:p-8">
        {step.id === "project" ? <ProjectStep workspaceSlug={workspaceSlug} /> : null}
        {step.id === "key" ? (
          <KeyStep
            workspaceSlug={workspaceSlug}
            projectSlug={step.projectSlug}
            apiKey={step.apiKey}
            onKey={setApiKey}
            onContinue={() => setKeySaved(true)}
          />
        ) : null}
        {step.id === "call" ? (
          <CallStep
            workspaceSlug={workspaceSlug}
            projectSlug={step.projectSlug}
            apiKey={step.apiKey}
          />
        ) : null}
      </div>
    </OnboardingFrame>
  )
}
