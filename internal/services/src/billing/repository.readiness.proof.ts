import { describe, it } from "vitest"
import {
  assertBillingReadiness,
  proveBillingReadiness,
} from "../../scripts/prove-billing-readiness"

describe("billing readiness in PostgreSQL", () => {
  it("waits for period-end grace while keeping period-start charges ready and capping pending end invoices", async () => {
    const result = await proveBillingReadiness()
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    assertBillingReadiness(result)
  })
})
