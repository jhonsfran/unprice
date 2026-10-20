import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createTRPCClient, httpLink } from "@trpc/client"
import type { AppRouter, RouterOutputs } from "@unprice/trpc/routes"
import { transformer } from "@unprice/trpc/transformer"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TRPCProvider } from "~/trpc/client"
import { BudgetLive } from "./budget-live"
import type { BudgetInspection } from "./budget-operations"

const now = Date.now()

const balance = {
  remaining: "61.2",
  held: "12.4",
  limits: [
    {
      id: "daily",
      window: "day" as const,
      enforce: "hard" as const,
      amount: "100",
      consumed: "26.4",
      held: "12.4",
      remaining: "61.2",
      resetsAt: now + 3_600_000,
    },
  ],
  asOf: now,
}

const page: BudgetInspection = {
  budget: {
    key: "customer:acme",
    unit: "money:USD",
    version: 7,
    limits: [{ id: "daily", amount: "100", window: "day", enforce: "hard" }],
    holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
    onUnavailable: "deny",
    closesAt: null,
    closed: false,
    balance,
    operations: {
      upsert: 1,
      authorize: 2,
      settle: 1,
      release: 0,
      charge: 0,
      record: 0,
      lease: 0,
      report: 0,
    },
  },
  history: [{ windowId: "day", start: now - 86_400_000, end: now, consumed: "40" }],
  expiringNext: {
    rows: [
      {
        kind: "hold",
        id: "h_4812",
        idempotencyKey: "job-991",
        amount: "8",
        ttlMs: 60_000,
        createdAt: now - 10_000,
        expiresAt: now + 175_000,
        state: { status: "open" },
      },
    ],
    examined: 1000,
    next: { dueAt: now + 175_000, id: "h_4812" },
  },
  listed: "8",
  closedRecently: [],
  catalog: {
    id: "bgt_1",
    key: "customer:acme",
    unit: "money:USD",
    version: 7,
    cap: "hard",
    limits: [{ id: "daily", amount: "100", window: "day", enforce: "hard" }],
    closesAt: null,
    status: "open",
    createdAt: now,
    updatedAt: now,
  },
}

type AuditRow = RouterOutputs["budgets"]["audit"][number]

function render(
  pages: BudgetInspection[],
  { canRelease = false, audit = [] }: { canRelease?: boolean; audit?: AuditRow[] } = {}
): string {
  const queryClient = new QueryClient()
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpLink({ url: "http://localhost/unused", transformer })],
  })
  queryClient.setQueryData([["budgets", "inspect"], { input: { id: "bgt_1" }, type: "infinite" }], {
    pages,
    pageParams: pages.map((_, index) => (index === 0 ? null : pages[index - 1]?.expiringNext.next)),
  })
  queryClient.setQueryData([["budgets", "audit"], { input: { id: "bgt_1" }, type: "query" }], audit)

  return renderToString(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <BudgetLive id="bgt_1" listHref="/ws/proj/budgets" canRelease={canRelease} />
      </TRPCProvider>
    </QueryClientProvider>
  ).replace(/<!-- -->/g, "")
}

describe("BudgetLive", () => {
  it("renders the live balance, the limit line, and the money line from one inspection", () => {
    const html = render([page])

    expect(
      [
        "61.20 USD",
        "Consumed today",
        "26.40 used · 12.40 held · 61.20 left of 100.00",
        "8.00 of 12.40 held listed",
        "job-991",
        "Scan further",
        "Nothing closed in the last hour.",
        "No operator actions.",
      ].filter((text) => !html.includes(text))
    ).toEqual([])
  })

  it("says the scan reached the end after an empty last page and hides Scan further", () => {
    const empty = { ...page, expiringNext: { rows: [], examined: 3, next: null }, listed: "0" }
    const html = render([page, empty])

    expect([html.includes("No more open reservations."), html.includes("Scan further")]).toEqual([
      true,
      false,
    ])
  })

  it("offers Release on an open hold only to a member who may release", () => {
    expect([
      render([page]).includes("Release…"),
      render([page], { canRelease: true }).includes("Release…"),
    ]).toEqual([false, true])
  })

  it("lists operator actions with the released amount, status, and reason", () => {
    const html = render([page], {
      audit: [
        {
          id: "bga_2",
          budgetId: "bgt_1",
          action: "release_hold",
          subject: "h_4790",
          actorUserId: "usr_1",
          reason: "worker crashed pre-call",
          status: "applied",
          released: "3",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "bga_1",
          budgetId: "bgt_1",
          action: "release_hold",
          subject: "h_4700",
          actorUserId: "usr_2",
          reason: "job cancelled before start",
          status: "rejected",
          rejectionCode: "HOLD_CLOSED",
          createdAt: now,
          updatedAt: now,
        },
      ],
    })

    expect(
      [
        "h_4790",
        "3.00",
        "applied",
        "worker crashed pre-call",
        "usr_1",
        "h_4700",
        "rejected (HOLD_CLOSED)",
      ].filter((text) => !html.includes(text))
    ).toEqual([])
    expect(html.includes("No operator actions.")).toBe(false)
  })
})
