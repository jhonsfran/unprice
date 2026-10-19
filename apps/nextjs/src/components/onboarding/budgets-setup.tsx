"use client"

import { useMutation } from "@tanstack/react-query"
import { DOCS_DOMAIN } from "@unprice/config"
import { Button, buttonVariants } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { LedgerRow } from "@unprice/ui/station"
import { cn } from "@unprice/ui/utils"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { type FormEvent, useEffect, useRef, useState } from "react"
import Balancer from "react-wrap-balancer"

import { updateContextCookies } from "~/actions/update-context-cookies"
import { BUDGETS_INSTALL, budgetsTwoCalls } from "~/components/landing/budgets-snippets"
import { CodeEditor } from "~/components/landing/code-editor"
import CopyToClipboard from "~/components/landing/copy-to-clipboard"
import { SuperLink } from "~/components/super-link"
import { useTRPC } from "~/trpc/client"

// The Budgets setup: what a visitor from /budgets needs before the first call, and nothing
// else. Budgets and API keys live in a project, so the moments are a project, a runtime key,
// and the two calls. No plan, Sandbox, or payment provider: those belong to the billing
// onboarding, which stays the default for every other signup.
//
// The project slug rides in the URL (`?project=`), so a reload resumes at the key instead of
// creating a second project. The key is shown once, inside the code: the screen masks it, and
// "Copy code" copies the snippet with the real key so it runs as pasted.

type MomentId = "project" | "key" | "call"

const MOMENTS: Array<{
  id: MomentId
  label: string
  setup: string
  operative: string
  sub: string
}> = [
  {
    id: "project",
    label: "Project",
    setup: "Create a",
    operative: "project.",
    sub: "Budgets and API keys live in a project. Name it after the product your agents run in.",
  },
  {
    id: "key",
    label: "Runtime key",
    setup: "Create a",
    operative: "runtime key.",
    sub: "Your code spends with this key. It can create a budget and tighten it, but it cannot raise a cap.",
  },
  {
    id: "call",
    label: "Two calls",
    setup: "Wrap",
    operative: "one call.",
    sub: "Install the package, set a cap, and wrap the call your agent already makes.",
  },
]

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

export function BudgetsSetup() {
  const trpc = useTRPC()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const projectSlug = searchParams.get("project")
  const [name, setName] = useState("Budgets")
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousMomentRef = useRef<MomentId | null>(null)

  const createProject = useMutation(trpc.projects.create.mutationOptions())
  const createKey = useMutation(trpc.apikeys.create.mutationOptions())

  const momentId: MomentId = apiKey ? "call" : projectSlug ? "key" : "project"
  const activeIndex = MOMENTS.findIndex(({ id }) => id === momentId)
  const moment = MOMENTS[activeIndex] ?? MOMENTS[0]!

  useEffect(() => {
    if (previousMomentRef.current !== null && previousMomentRef.current !== momentId) {
      headingRef.current?.focus({ preventScroll: true })
    }
    previousMomentRef.current = momentId
  }, [momentId])

  const onCreateProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    try {
      const { project } = await createProject.mutateAsync({
        name: name.trim() || "Budgets",
        defaultCurrency: "USD",
        timezone: "UTC",
      })
      await updateContextCookies(workspaceSlug, project.slug)
      router.replace(`?${new URLSearchParams({ intent: "budgets", project: project.slug })}`)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const onCreateKey = async () => {
    if (!projectSlug) return
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
      setApiKey(apikey.key)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <div className="flex w-full flex-col gap-8">
      <header className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
          <span className="font-mono text-background-text text-xs uppercase tracking-widest">
            budgets · setup
          </span>
          <span className="font-mono text-[10px] text-background-text tabular-nums">
            {String(activeIndex + 1).padStart(2, "0")} / 03
          </span>
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-primary text-background-textContrast text-display-3 outline-none"
        >
          <Balancer>
            <span className="text-background-text">{moment.setup}</span> {moment.operative}
          </Balancer>
        </h1>
        <p className="max-w-2xl text-background-text text-sm leading-6">{moment.sub}</p>
      </header>

      <section
        aria-label="Budgets setup"
        className="overflow-hidden rounded-lg border border-background-border bg-surface-panel shadow-raised"
      >
        <ol className="grid grid-cols-3 border-background-border border-b bg-background-bgSubtle">
          {MOMENTS.map((item, index) => {
            const current = index === activeIndex
            const completed = index < activeIndex
            return (
              <li
                key={item.id}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2 border-background-border border-r px-3 py-3 text-xs last:border-r-0 sm:px-5",
                  current || completed ? "text-background-textContrast" : "text-background-text"
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px]",
                    current
                      ? "bg-info-solid text-white"
                      : completed
                        ? "bg-success-solid text-white"
                        : "bg-background-bgActive text-background-text"
                  )}
                >
                  {index + 1}
                </span>
                <span className="truncate">{item.label}</span>
              </li>
            )
          })}
        </ol>

        <div className="flex flex-col gap-6 p-6 sm:p-8">
          {momentId === "project" ? (
            <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
              <form onSubmit={onCreateProject} className="flex flex-col gap-5">
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
          ) : null}

          {momentId === "key" ? (
            <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
              <div className="flex flex-col gap-5">
                <p className="text-background-textContrast text-sm leading-6">
                  The key your code spends with. It is shown once, already in the code on the next
                  step.
                </p>
                <Button
                  type="button"
                  variant="primary"
                  className="w-fit"
                  disabled={createKey.isPending}
                  onClick={onCreateKey}
                >
                  {createKey.isPending ? "Creating key…" : "Create runtime key"}
                </Button>
                <p className="text-background-text text-xs leading-5">
                  Raising a cap needs a config key. Create one later in the project's API keys, and
                  keep it out of the environment that spends.
                </p>
              </div>
              <Preview
                title="Runtime key"
                rows={[
                  { label: "project", fact: projectSlug ?? "" },
                  { label: "type", fact: "runtime" },
                  { label: "spends", fact: "authorize · charge · record" },
                  { label: "raise a cap", fact: "config key only" },
                ]}
              />
            </div>
          ) : null}

          {momentId === "call" && apiKey ? (
            <div className="flex flex-col gap-5">
              <p role="alert" className="text-sm text-warning-text">
                Your key is in the code below, and it is shown once. Copy it now.
              </p>

              <div className="flex items-center justify-between gap-2 rounded-md border border-background-border px-3 py-1.5">
                <code className="font-mono text-xs">{BUDGETS_INSTALL}</code>
                <CopyToClipboard code={BUDGETS_INSTALL} variant="ghost" className="size-7" />
              </div>

              <figure className="overflow-hidden rounded-md border border-background-border bg-surface-raised">
                <figcaption className="flex items-center justify-between gap-4 border-background-border border-b py-1.5 pr-1.5 pl-4">
                  <span className="font-mono text-background-text text-xs uppercase tracking-widest">
                    agent.ts
                  </span>
                  <CopyToClipboard
                    code={budgetsTwoCalls(apiKey)}
                    variant="ghost"
                    size="sm"
                    label="Copy code"
                    className="gap-1.5"
                  />
                </figcaption>
                <div className="overflow-x-auto px-4 py-4">
                  <CodeEditor codeBlock={budgetsTwoCalls(maskKey(apiKey))} language="typescript" />
                </div>
              </figure>

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
          ) : null}

          {error ? (
            <p role="alert" className="text-danger-text text-sm">
              {error}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
