/**
 * BSS-style billing pipeline. The six phases below run as a loop over the
 * subscription's life. Each file in this directory owns exactly one phase;
 * the XState machine in `subscriptions/machine.ts` is the orchestrator that
 * sequences them.
 *
 *   PROVISION → METER → RATE → RESERVE/DRAW → BILL → SETTLE → RENEW
 *
 * | Phase         | File / Owner                                             |
 * |---------------|----------------------------------------------------------|
 * | PROVISION     | `provision-period.ts` + `derive-provision-inputs.ts`     |
 * |               | (issued grants per period; XState `activating` actor)    |
 * | METER         | `ingestion/*` + `entitlements/EntitlementWindowDO`       |
 * |               | (event ingest + DO buffering — no use case)              |
 * | RATE          | `rating/service.ts ::rateBillingPeriod` (pure pricing)   |
 * | RESERVE/DRAW  | `wallet/service.ts ::createReservation, flushReservation`|
 * | BILL          | `bill-period.ts` (XState `invoicing` actor)              |
 * | SETTLE        | `settle-invoice.ts` (webhook + sync paths)               |
 * | RENEW         | `renew-period.ts` (XState `renewing` actor)              |
 *
 * Mode-dependent behavior is concentrated in `billing/strategy.ts`. Three
 * billing modes project onto these phases as follows:
 *
 *   pay_in_advance   — all six phases; BILL fires at period_start
 *   pay_in_arrear    — all six phases; BILL fires at period_end
 *   wallet_only      — PROVISION + METER + RATE + RESERVE/DRAW + RENEW only;
 *                       BILL and SETTLE are skipped (the wallet is the
 *                       point of charge — INVOICE events are rejected by a
 *                       guard in the machine)
 *
 * Adding a fourth mode = one new switch arm in `billingStrategyFor()` and,
 * if the BILL/SETTLE arcs need to be skipped, one additional guard in the
 * machine. No new states, no new use cases.
 */

export { activateSubscription } from "./provision-period"
export type { ActivateSubscriptionDeps, ActivationGrant } from "./provision-period"
export { deriveActivationInputsFromPlan } from "./derive-provision-inputs"
export { billPeriod } from "./bill-period"
export { renewPeriod } from "./renew-period"
export { settlePrepaidInvoiceToWallet } from "./settle-invoice"
