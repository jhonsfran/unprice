import type { Currency, SubscriptionInvoice } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { WalletService } from "../../wallet"
import type { UnPriceWalletError } from "../../wallet/errors"

// On confirmed payment, two things land in the ledger:
//
// 1) `topup → receivable` always — clears the negative balance the invoice
//    drafted into `customer.*.receivable` (debited at invoice creation in
//    `invoiceSubscription`). Applies to both `pay_in_advance` and
//    `pay_in_arrear`: the receivable was opened the same way for both.
//
// 2) `topup → purchased` only for `pay_in_advance` — funds the customer's
//    usage runway for the period they just paid for. Pay-in-arrears doesn't
//    materialize runway: usage during the period drains `granted` (credit_line)
//    and is reconciled at the next period close.
//
// Provider-agnostic: called from the async webhook path (Stripe) and the
// sync `_collectInvoicePayment` path (Sandbox + any future synchronous
// provider). Idempotency keyed on the invoice id (not the webhook event id)
// so duplicate payment.succeeded webhooks for the same invoice — common
// with providers that emit both `invoice.paid` and `payment_intent.succeeded`
// — converge on the same ledger row instead of double-settling.
//
// TODO: payment.reversed should claw back both transfers. Skipped for now
// because the runway funds may already have been consumed; needs a separate
// path that handles partial clawback.
export async function settlePrepaidInvoiceToWallet({
  walletService,
  invoice,
}: {
  walletService: WalletService
  invoice: SubscriptionInvoice
}): Promise<Result<void, UnPriceWalletError>> {
  if (invoice.totalAmount <= 0) {
    return Ok(undefined)
  }

  const currency = invoice.currency as Currency

  const settled = await walletService.settleReceivable({
    projectId: invoice.projectId,
    customerId: invoice.customerId,
    currency,
    paidAmount: invoice.totalAmount,
    idempotencyKey: `invoice_receivable:${invoice.id}`,
    metadata: {
      invoice_id: invoice.id,
      subscription_id: invoice.subscriptionId,
      when_to_bill: invoice.whenToBill,
    },
  })

  if (settled.err) {
    return Err(settled.err)
  }

  if (invoice.whenToBill !== "pay_in_advance") {
    return Ok(undefined)
  }

  const runway = await walletService.adjust({
    projectId: invoice.projectId,
    customerId: invoice.customerId,
    currency,
    signedAmount: invoice.totalAmount,
    actorId: "system:invoice-settlement",
    reason: "Prepaid invoice payment funds usage runway",
    source: "purchased",
    idempotencyKey: `invoice_purchased:${invoice.id}`,
  })

  if (runway.err) {
    return Err(runway.err)
  }

  return Ok(undefined)
}
