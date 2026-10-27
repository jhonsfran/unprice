import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createConnection, eq } from "@unprice/db"
import { billingPeriods } from "@unprice/db/schema"
import { DrizzleBillingRepository } from "../src/billing/repository.drizzle"
import { LATE_EVENT_GRACE_MS } from "../src/entitlements/domain"

const START = Date.UTC(2026, 8, 1)
const END = Date.UTC(2026, 9, 1)
const PHASE_END = START + 2 * 86_400_000
const fixtures = [
  [
    "cross_old_usage",
    "sub_readiness",
    "phase_prior_usage",
    "cross_phase",
    END,
    START,
    END,
    "pending",
    "pay_in_arrear",
  ],
  [
    "cross_new_fixed",
    "sub_readiness",
    "phase_next_fixed",
    "cross_phase",
    END,
    END,
    END + 86400000,
    "pending",
    "pay_in_advance",
  ],
  [
    "fixed",
    "sub_readiness",
    "phase_readiness",
    "advance_start",
    START,
    START,
    END,
    "pending",
    "pay_in_advance",
  ],
  [
    "usage",
    "sub_readiness",
    "phase_readiness",
    "advance_usage",
    END,
    START,
    END,
    "pending",
    "pay_in_advance",
  ],
  [
    "arrears",
    "sub_readiness",
    "phase_readiness",
    "arrears",
    END,
    START,
    END,
    "pending",
    "pay_in_arrear",
  ],
  [
    "mixed_usage",
    "sub_readiness",
    "phase_readiness",
    "mixed",
    END,
    START,
    END,
    "pending",
    "pay_in_advance",
  ],
  [
    "mixed_fixed",
    "sub_readiness",
    "phase_readiness",
    "mixed",
    END,
    END,
    END + 86_400_000,
    "pending",
    "pay_in_advance",
  ],
  [
    "next_fixed",
    "sub_readiness",
    "phase_readiness",
    "advance_next_fixed",
    END,
    END,
    END + 86_400_000,
    "pending",
    "pay_in_advance",
  ],
  [
    "cap_fixed",
    "sub_cap",
    "phase_cap",
    "cap_fixed",
    START,
    START,
    END,
    "pending",
    "pay_in_advance",
  ],
  ["cap_usage", "sub_cap", "phase_cap", "cap_usage", END, START, END, "pending", "pay_in_advance"],
  [
    "cap_invoiced",
    "sub_cap",
    "phase_cap",
    "cap_invoiced",
    END,
    START,
    END,
    "invoiced",
    "pay_in_advance",
  ],
  [
    "other_phase",
    "sub_cap",
    "phase_other",
    "other_phase",
    END,
    START,
    END,
    "pending",
    "pay_in_advance",
  ],
]

function literal(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`
  throw new Error("Unsupported PostgreSQL proof parameter")
}

const setup = `
  CREATE TEMP TABLE unprice_billing_periods (
    id text, project_id text, subscription_id text, subscription_phase_id text,
    statement_key text, invoice_at_m bigint, cycle_start_at_m bigint,
    cycle_end_at_m bigint, status text, when_to_bill text, updated_at_m bigint
  );
  INSERT INTO unprice_billing_periods VALUES ${fixtures.map((row) => `(${[row[0], "proj_proof", ...row.slice(1), 0].map(literal).join(",")})`).join(",")};
`

export async function proveBillingReadiness() {
  const db = createConnection({
    env: "test",
    primaryDatabaseUrl: "postgresql://unused:unused@invalid.example/unused",
    logger: false,
    singleton: false,
  })
  if (!("$client" in db)) throw new Error("Expected the non-transactional test client")
  const mutations: string[] = []
  Object.defineProperty(db.$client, "query", {
    value: async (query: { text: string; rowMode?: string }, parameters: unknown[] = []) => {
      const prepared = `PREPARE billing_probe AS ${query.text}; EXECUTE billing_probe(${parameters.map(literal).join(",")}); DEALLOCATE billing_probe;`
      const text = execFileSync(
        "rtk",
        [
          "proxy",
          "docker",
          "exec",
          "-i",
          "-e",
          "PGPASSWORD=postgres",
          "codex-billing-proof-postgres",
          "psql",
          "-X",
          "-q",
          "-A",
          "-t",
          "-F",
          "\t",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "postgres",
          "-d",
          "unprice_billing_proof",
        ],
        {
          input: `BEGIN; ${setup} ${mutations.join("\n")} ${prepared} ROLLBACK;`,
          encoding: "utf8",
        }
      ).trim()
      if (query.text.startsWith("update ")) mutations.push(prepared)
      const rows = text ? text.split("\n").map((row) => row.split("\t")) : []
      return { rows }
    },
  })
  try {
    const repository = new DrizzleBillingRepository(db)
    const ready = async (now: number) =>
      (
        await repository.listPendingPeriodGroups({
          projectId: "proj_proof",
          subscriptionId: "sub_readiness",
          now,
          lateEventGraceMs: LATE_EVENT_GRACE_MS,
        })
      )
        .map((row) => row.statementKey)
        .sort()
    const atStart = await ready(START)
    const atEnd = await ready(END)
    const beforeGraceEnd = await ready(END + LATE_EVENT_GRACE_MS - 1)
    const atGraceEnd = await ready(END + LATE_EVENT_GRACE_MS)
    await repository.capPendingPeriodsAtPhaseEnd({ phaseId: "phase_cap", phaseEndAt: PHASE_END })
    const capped = await db
      .select({
        id: billingPeriods.id,
        cycleEndAt: billingPeriods.cycleEndAt,
        invoiceAt: billingPeriods.invoiceAt,
      })
      .from(billingPeriods)
      .where(eq(billingPeriods.subscriptionId, "sub_cap"))
      .orderBy(billingPeriods.id)
    return { atStart, atEnd, beforeGraceEnd, atGraceEnd, capped }
  } finally {
    await db.$client.end()
  }
}

export function assertBillingReadiness(result: Awaited<ReturnType<typeof proveBillingReadiness>>) {
  assert.deepEqual(result, {
    atStart: ["advance_start"],
    atEnd: ["advance_next_fixed", "advance_start"],
    beforeGraceEnd: ["advance_next_fixed", "advance_start"],
    atGraceEnd: [
      "advance_next_fixed",
      "advance_start",
      "advance_usage",
      "arrears",
      "cross_phase",
      "cross_phase",
      "mixed",
    ],
    capped: [
      { id: "cap_fixed", cycleEndAt: PHASE_END, invoiceAt: START },
      { id: "cap_invoiced", cycleEndAt: END, invoiceAt: END },
      { id: "cap_usage", cycleEndAt: PHASE_END, invoiceAt: PHASE_END },
      { id: "other_phase", cycleEndAt: END, invoiceAt: END },
    ],
  })
}
