import { expect, it, vi } from "vitest"
import { type RunBudgetMutationSerializer, RunBudgetRpcShell } from "./rpc-shell"
import { RUN_BUDGET_TEST_NOW, createRunBudgetProcessorHarness } from "./testing/harness"
import { createRunBudgetApplyInput, createRunBudgetStartInput } from "./testing/processor-contract"

function createQueuedSerializer(): RunBudgetMutationSerializer {
  let tail = Promise.resolve()
  return async <T>(mutation: () => Promise<T>): Promise<T> => {
    const previous = tail
    let release: () => void = () => undefined
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await mutation()
    } finally {
      release()
    }
  }
}

it("serializes concurrent start calls so the wallet reservation is created once", async () => {
  const harness = createRunBudgetProcessorHarness()
  let releaseReservationCreate: () => void = () => undefined
  const reservationGate = new Promise<void>((resolve) => {
    releaseReservationCreate = resolve
  })
  harness.createReservation.mockImplementationOnce(async () => {
    await reservationGate
    return { val: { reservationId: "res_test_123", allocationAmount: 100_000 } }
  })
  const shell = new RunBudgetRpcShell(harness.processor, createQueuedSerializer())
  const input = createRunBudgetStartInput()

  const first = shell.startRun(input)
  await vi.waitFor(() => expect(harness.createReservation).toHaveBeenCalledTimes(1))
  const second = shell.startRun(input)
  await Promise.resolve()
  expect(harness.createReservation).toHaveBeenCalledTimes(1)

  releaseReservationCreate()
  await expect(Promise.all([first, second])).resolves.toEqual([
    expect.objectContaining({ status: "running" }),
    expect.objectContaining({ status: "running" }),
  ])
  expect(harness.createReservation).toHaveBeenCalledTimes(1)
})

it("serializes end before apply so usage cannot enter a closing run", async () => {
  const harness = createRunBudgetProcessorHarness()
  const shell = new RunBudgetRpcShell(harness.processor, createQueuedSerializer())
  await shell.startRun(createRunBudgetStartInput())
  harness.pricingApply.mockClear()
  let finishRelease: () => void = () => undefined
  const releaseGate = new Promise<void>((resolve) => {
    finishRelease = resolve
  })
  harness.releaseReservation.mockImplementationOnce(async () => {
    await releaseGate
    return {
      val: { releasedAmount: 0, restoredGrantedAmount: 0, refundedPurchasedAmount: 0 },
    }
  })

  const ending = shell.endRun({
    runId: "run_1",
    customerId: "cus_1",
    projectId: "proj_1",
    status: "completed",
    endedAt: RUN_BUDGET_TEST_NOW + 1,
  })
  await Promise.resolve()
  const applying = shell.applySyncEvent(createRunBudgetApplyInput())
  await Promise.resolve()
  expect(harness.pricingApply).not.toHaveBeenCalled()

  finishRelease()
  await expect(ending).resolves.toMatchObject({ status: "completed" })
  await expect(applying).resolves.toMatchObject({
    allowed: false,
    rejectionReason: "RUN_BUDGET_EXCEEDED",
    budget: { status: "completed" },
  })
  expect(harness.pricingApply).not.toHaveBeenCalled()
})

it("routes every mutating RPC and alarm through one serializer while status stays read-only", async () => {
  const harness = createRunBudgetProcessorHarness()
  let serialized = 0
  const shell = new RunBudgetRpcShell(harness.processor, async (mutation) => {
    serialized++
    return mutation()
  })

  await shell.startRun(createRunBudgetStartInput())
  await shell.applySyncEvent(createRunBudgetApplyInput())
  await shell.flushCaptures()
  await shell.flushCapturesForInvoicing({ statementKey: "stmt_1", billingPeriodIds: [] })
  await shell.endRun({
    runId: "run_1",
    customerId: "cus_1",
    projectId: "proj_1",
    status: "completed",
    endedAt: RUN_BUDGET_TEST_NOW + 1,
  })
  await shell.alarm()
  await shell.getRunStatus({ runId: "run_1", customerId: "cus_1", projectId: "proj_1" })

  expect(serialized).toBe(6)
})
