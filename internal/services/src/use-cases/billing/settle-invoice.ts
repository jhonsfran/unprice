import type { Currency, SubscriptionInvoice } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { WalletService } from "../../wallet"
import type { UnPriceWalletError } from "../../wallet/errors"

// Invoice settlement posts a single ledger transfer:
//
//   topup → receivable   (amount = invoice.totalAmount)
//
// This clears the receivable IOU that `invoiceSubscription` opened when it
// debited `customer.*.receivable` at invoice creation. Behavior is identical
// for `pay_in_advance` and `pay_in_arrear` — both modes draft the invoice the
// same way, so both settle the same way.
//
// Usage runway is NOT funded here. The customer's per-period usage allowance
// is issued at activation time as a `credit_line → granted` grant (see
// `derive-activation-inputs.ts`); the DO drains it on each priced event.
// Funding `customer.*.available.purchased` from invoice settlement would
// double-count the flat-fee dollars (paying $50 in subscription fee should
// not also grant $50 of usage runway). The `purchased` account is reserved
// for explicit customer wallet top-ups, which are a separate operation.
//
// Provider-agnostic: called from the async webhook path (Stripe) and the
// sync `_collectInvoicePayment` path (Sandbox + any future synchronous
// provider). Idempotency keyed on the invoice id (not the webhook event id)
// so duplicate payment.succeeded webhooks for the same invoice — common
// with providers that emit both `invoice.paid` and `payment_intent.succeeded`
// — converge on the same ledger row instead of double-settling.
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

  return Ok(undefined)
}
