import type { BillingConfig } from "../shared"
import {
  addByInterval,
  getAnchor,
  normalizeBillingStartForInterval,
  setUtc,
  setUtcDay,
  startOfUtcDay,
  startOfUtcHour,
} from "./utils"

export interface CycleWindow {
  start: number
  end: number
  periodsPassed: number
  isTrial?: boolean
}

export interface CalculateCycleWindowParams {
  effectiveStartDate: number
  effectiveEndDate: number | null
  trialEndsAt: number | null
  now: number
  config: {
    name: BillingConfig["name"]
    interval: BillingConfig["billingInterval"]
    intervalCount: BillingConfig["billingIntervalCount"]
    anchor: BillingConfig["billingAnchor"]
    planType: BillingConfig["planType"]
  }
}

// =================================================================================
// CORE LOGIC: calculateCycleWindow
// This is the main function for determining a subscription's current time slice.
// =================================================================================
/**
 * Calculates the current cycle window for a subscription, including proration details.
 * All calculations are performed in UTC with exclusive end dates ([start, end)).
 *
 * @param params - The parameters for the calculation.
 * @returns The calculated CycleWindow with proration, or null if `now` is not in an active cycle.
 */
export function calculateCycleWindow(params: CalculateCycleWindowParams): CycleWindow | null {
  const { effectiveStartDate, effectiveEndDate, trialEndsAt, now, config } = params

  if (now < effectiveStartDate || (effectiveEndDate && now >= effectiveEndDate)) {
    return null
  }

  // --- 1. Handle Trial Cycle (No changes needed) ---
  if (trialEndsAt && now < trialEndsAt) {
    const start = effectiveStartDate
    const end = Math.min(trialEndsAt, effectiveEndDate ?? Number.POSITIVE_INFINITY)
    // trial is not billable
    return { start, end, periodsPassed: 0, isTrial: true }
  }

  // --- 2. Handle Onetime Plan Cycle (No changes needed) ---
  if (config.planType === "onetime") {
    const start = effectiveStartDate
    const end = effectiveEndDate ?? Number.POSITIVE_INFINITY
    // For onetime without effectiveEndDate, tests expect infinite window with
    // billableSeconds computed as elapsed since start and proration 0.
    if (!effectiveEndDate) {
      return { start, end, periodsPassed: 0, isTrial: false }
    }
    return { start, end, periodsPassed: 0, isTrial: false }
  }

  // --- 3. Recurring Plan Validation and Setup (No changes needed) ---
  const { interval, intervalCount, anchor } = config

  const normalizedEffectiveStartDate = normalizeBillingStartForInterval(
    effectiveStartDate,
    interval
  )
  const anchorValue = getAnchor(normalizedEffectiveStartDate, interval, anchor)

  const rawPaidPeriodStart = trialEndsAt
    ? Math.max(effectiveStartDate, trialEndsAt)
    : effectiveStartDate
  const paidPeriodStart = normalizeBillingStartForInterval(rawPaidPeriodStart, interval)

  if (now < rawPaidPeriodStart) {
    return null
  }

  const paidPeriodStartDateObj = new Date(paidPeriodStart)

  // --- 4. Find the First Paid Cycle Start Date (No changes needed) ---
  let firstPaidCycleStart: Date

  // This logic correctly finds the first anchor date on or after the paid period starts.
  const tempDate = paidPeriodStartDateObj
  switch (interval) {
    case "minute": {
      // Align minutes to multiples of `billingIntervalCount` and seconds to `anchor`.
      const c = Math.max(1, intervalCount)
      const y = tempDate.getUTCFullYear()
      const m = tempDate.getUTCMonth()
      const d = tempDate.getUTCDate()
      const h = tempDate.getUTCHours()
      const minute = tempDate.getUTCMinutes()
      const alignedMinute = minute - (minute % c)
      firstPaidCycleStart = new Date(Date.UTC(y, m, d, h, alignedMinute, anchorValue, 0))
      break
    }
    case "day":
      firstPaidCycleStart = startOfUtcHour(setUtc(tempDate, { hours: anchorValue }))
      break
    case "week":
      firstPaidCycleStart = startOfUtcDay(setUtcDay(tempDate, anchorValue, 0))
      break
    case "month":
    case "year":
      firstPaidCycleStart = startOfUtcDay(setUtc(tempDate, { date: anchorValue }))
      break
    default:
      throw new Error(`Invalid billing interval: ${interval}`)
  }

  if (firstPaidCycleStart.getTime() < paidPeriodStartDateObj.getTime()) {
    firstPaidCycleStart = addByInterval(firstPaidCycleStart, interval, intervalCount)
  }

  // --- 5. Iterate to Find the Current Window (No changes needed) ---
  let currentCycleStart = firstPaidCycleStart

  // This check handles the case where `now` is in the initial "stub" period
  // before the first full anchor cycle begins.
  if (now < firstPaidCycleStart.getTime()) {
    // For minute intervals with count > 1, return the full aligned window and
    // compute proration from the paid start to avoid tiny stub windows.
    if (interval === "minute" && intervalCount > 1) {
      const fullStartDate = addByInterval(firstPaidCycleStart, "minute", -intervalCount)
      const fullStart = fullStartDate.getTime()
      const end = Math.min(
        firstPaidCycleStart.getTime(),
        effectiveEndDate ?? Number.POSITIVE_INFINITY
      )
      // Use elapsed semantics from the billable start inside the aligned window
      return { start: fullStart, end, periodsPassed: 0 }
    }

    // Default behavior (non-minute or count=1): stub from paid start to first anchor
    const start = paidPeriodStart
    const end = Math.min(
      firstPaidCycleStart.getTime(),
      effectiveEndDate ?? Number.POSITIVE_INFINITY
    )
    return { start, end, periodsPassed: 0 }
  }

  // If we are past the first anchor, find the correct cycle.
  let periodsPassed = 0
  let nextCycleStart = addByInterval(currentCycleStart, interval, intervalCount)
  while (now >= nextCycleStart.getTime()) {
    currentCycleStart = nextCycleStart
    nextCycleStart = addByInterval(currentCycleStart, interval, intervalCount)
    periodsPassed++
  }

  // --- 6. Construct, Cap, and Return the Final Window ---
  const start = currentCycleStart.getTime()
  const end = Math.min(nextCycleStart.getTime(), effectiveEndDate ?? Number.POSITIVE_INFINITY)

  return { start, end, periodsPassed }
}

// =================================================================================
// 3. NEW PUBLIC FUNCTION: calculateNextNCycles
// This function now correctly reuses the logic from `calculateCurrentCycleWindow`.
// =================================================================================

export interface CalculateNextCyclesParams {
  /** The date to use as the starting point. The first cycle returned will contain this date. */
  referenceDate: number
  /** The effective start date of the entire subscription. */
  effectiveStartDate: number
  /** The effective end date of the subscription, or null if it never ends. */
  effectiveEndDate: number | null
  /** The date the trial ends, or null if there is no trial. */
  trialEndsAt: number | null
  /** The recurring billing configuration with a required numeric anchor. */
  config: {
    name: BillingConfig["name"]
    interval: BillingConfig["billingInterval"]
    intervalCount: BillingConfig["billingIntervalCount"]
    anchor: number
    planType: BillingConfig["planType"]
  }
  /** The total number of cycles to generate. */
  count: number
}

/**
 * Calculates the next N cycles for a subscription, starting from a given date.
 * This function intelligently handles trial periods and reuses the core cycle logic
 * to ensure consistency and robustness.
 *
 * @param params - The parameters for the calculation.
 * @returns An array of calculated cycles.
 */
export function calculateNextNCycles(
  params: CalculateNextCyclesParams
): { end: number; start: number; isTrial?: boolean }[] {
  const { referenceDate, effectiveStartDate, effectiveEndDate, trialEndsAt, config, count } = params

  // Onetime plans have a single window; return it if applicable
  if (config.planType === "onetime") {
    const single = calculateCycleWindow({
      now: referenceDate,
      effectiveStartDate,
      effectiveEndDate,
      trialEndsAt,
      config,
    })
    return single ? [single] : []
  }

  // If reference is before the subscription starts, nothing to return
  if (referenceDate < effectiveStartDate) return []

  const core = { effectiveStartDate, effectiveEndDate, trialEndsAt, config }

  const results: { end: number; start: number; isTrial?: boolean }[] = []

  // Start from the very first window at the effective start
  let current = calculateCycleWindow({ now: effectiveStartDate, ...core })
  if (!current) return []
  results.push({
    end: current.end,
    start: current.start,
    isTrial: current.isTrial,
  })

  // Accumulate all cycles up to and including the one that contains the reference date
  while (current.end <= referenceDate) {
    if (effectiveEndDate && current.end >= effectiveEndDate) break
    const next = calculateCycleWindow({ now: current.end, ...core })
    if (!next) break
    results.push({
      end: next.end,
      start: next.start,
      isTrial: next.isTrial,
    })
    current = next
  }

  // Append `count` additional future cycles beyond the reference-containing window
  for (let i = 0; i < count; i++) {
    if (effectiveEndDate && current.end >= effectiveEndDate) break
    const next = calculateCycleWindow({ now: current.end, ...core })
    if (!next) break
    results.push({
      end: next.end,
      start: next.start,
      isTrial: next.isTrial,
    })
    current = next
  }

  return results
}
