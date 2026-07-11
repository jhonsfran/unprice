import { Err, Ok } from "@unprice/error"
import { UnPriceWalletError, type WalletErrorCode } from "@unprice/services/wallet"
import { vi } from "vitest"
import type { EntitlementWindowWalletOps, EntitlementWindowWalletProvider } from "../ports"

export type EntitlementWindowWalletHarnessOverrides = Partial<{
  allocationAmount: number
  captureError: WalletErrorCode
  createError: WalletErrorCode
  extendAmount: number
  extendError: WalletErrorCode
  releaseError: WalletErrorCode
}>

export function createEntitlementWindowWalletHarness(
  overrides: EntitlementWindowWalletHarnessOverrides = {}
) {
  const walletError = (message: WalletErrorCode) => new UnPriceWalletError({ message })
  const createReservation = vi.fn<EntitlementWindowWalletOps["createReservation"]>(async () =>
    overrides.createError
      ? Err(walletError(overrides.createError))
      : Ok({
          reservationId: "res_test",
          allocationAmount: overrides.allocationAmount ?? 1_000_000_000,
        })
  )
  const captureReservationUsage = vi.fn<EntitlementWindowWalletOps["captureReservationUsage"]>(
    async (input) =>
      overrides.captureError
        ? Err(walletError(overrides.captureError))
        : Ok({ capturedAmount: input.amount })
  )
  const extendReservation = vi.fn<EntitlementWindowWalletOps["extendReservation"]>(async (input) =>
    overrides.extendError
      ? Err(walletError(overrides.extendError))
      : Ok({ grantedAmount: overrides.extendAmount ?? input.requestedAmount })
  )
  const releaseReservation = vi.fn<EntitlementWindowWalletOps["releaseReservation"]>(async () =>
    overrides.releaseError
      ? Err(walletError(overrides.releaseError))
      : Ok({
          releasedAmount: 0,
          restoredGrantedAmount: 0,
          refundedPurchasedAmount: 0,
        })
  )
  const operations = {
    captureReservationUsage,
    createReservation,
    extendReservation,
    releaseReservation,
  } satisfies EntitlementWindowWalletOps
  const provider = { get: () => operations } satisfies EntitlementWindowWalletProvider

  return {
    captureReservationUsage,
    createReservation,
    extendReservation,
    provider,
    releaseReservation,
  }
}
