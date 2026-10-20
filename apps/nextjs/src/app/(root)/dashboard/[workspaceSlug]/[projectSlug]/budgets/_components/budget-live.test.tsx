import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createTRPCClient, httpLink } from "@trpc/client"
import type { AppRouter } from "@unprice/trpc/routes"
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

function render(pages: BudgetInspection[]): string {
  const queryClient = new QueryClient()
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpLink({ url: "http://localhost/unused", transformer })],
  })
  queryClient.setQueryData([["budgets", "inspect"], { input: { id: "bgt_1" }, type: "infinite" }], {
    pages,
    pageParams: pages.map((_, index) => (index === 0 ? null : pages[index - 1]?.expiringNext.next)),
  })

  return renderToString(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <BudgetLive id="bgt_1" listHref="/ws/proj/budgets" />
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
})
