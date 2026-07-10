import { formatLedgerMoney } from "@unprice/money"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { EvidenceMetricStrip, EvidenceMetricTile } from "~/components/analytics/evidence-panel"

type CustomerWallet = RouterOutputs["customers"]["getWallet"]["wallet"]

function BalanceRow({
  label,
  amount,
  currency,
}: {
  label: string
  amount: number
  currency: CustomerWallet["currency"]
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{formatLedgerMoney(amount, currency)}</dd>
    </div>
  )
}

export function WalletBalanceSummary({ wallet }: { wallet: CustomerWallet }) {
  const available = wallet.balances.purchased + wallet.balances.granted

  return (
    <EvidenceMetricStrip className="sm:grid-cols-3">
      {/* Available is the decision number; purchased/granted/held are its
          line items, not siblings */}
      <div className="bg-card/80 p-4">
        <p className="truncate text-muted-foreground text-xs">Available</p>
        <div className="mt-2 font-mono font-semibold text-foreground text-xl tabular-nums">
          {formatLedgerMoney(available, wallet.currency)}
        </div>
        <dl className="mt-3 flex flex-col gap-1.5 border-border/60 border-t pt-3 text-xs">
          <BalanceRow
            label="Purchased"
            amount={wallet.balances.purchased}
            currency={wallet.currency}
          />
          <BalanceRow label="Granted" amount={wallet.balances.granted} currency={wallet.currency} />
          <BalanceRow label="Held" amount={wallet.balances.reserved} currency={wallet.currency} />
        </dl>
      </div>
      <EvidenceMetricTile
        label="Wallet consumed"
        value={formatLedgerMoney(wallet.balances.walletConsumed, wallet.currency)}
        helper="Lifetime usage captured from wallet credits"
      />
      <EvidenceMetricTile
        label="Subscription charges"
        value={formatLedgerMoney(wallet.balances.subscriptionCharges, wallet.currency)}
        helper="Lifetime charges billed outside wallet funds"
      />
    </EvidenceMetricStrip>
  )
}
