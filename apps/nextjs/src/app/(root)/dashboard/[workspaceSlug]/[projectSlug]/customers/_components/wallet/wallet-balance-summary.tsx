import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { EvidenceMetricStrip, EvidenceMetricTile } from "~/components/analytics/evidence-panel"
import { formatWalletMoney } from "./format-wallet-money"

type CustomerWallet = RouterOutputs["customers"]["getWallet"]["wallet"]

type BalanceItem = {
  label: string
  description: string
  amount: number
  variant?: "default" | "outline" | "secondary"
}

export function WalletBalanceSummary({ wallet }: { wallet: CustomerWallet }) {
  const available = wallet.balances.purchased + wallet.balances.granted
  const balances: BalanceItem[] = [
    {
      label: "Available",
      description: "Purchased plus usable granted funds",
      amount: available,
      variant: "default",
    },
    {
      label: "Purchased",
      description: "Paid wallet balance",
      amount: wallet.balances.purchased,
      variant: "outline",
    },
    {
      label: "Granted",
      description: "Non-expired plan, trial, promo, or manual credits",
      amount: wallet.balances.granted,
      variant: "outline",
    },
    {
      label: "Held",
      description: "Reserved for active usage",
      amount: wallet.balances.reserved,
      variant: "secondary",
    },
    {
      label: "Wallet consumed",
      description: "Lifetime usage captured from wallet credits",
      amount: wallet.balances.walletConsumed,
      variant: "secondary",
    },
    {
      label: "Subscription charges",
      description: "Billed outside wallet funds",
      amount: wallet.balances.subscriptionCharges,
      variant: "secondary",
    },
  ]

  return (
    <EvidenceMetricStrip className="sm:grid-cols-3">
      {balances.map((balance) => (
        <EvidenceMetricTile
          key={balance.label}
          label={balance.label}
          value={formatWalletMoney(balance.amount, wallet.currency)}
          helper={balance.description}
          icon={<Badge variant={balance.variant}>{wallet.currency}</Badge>}
        />
      ))}
    </EvidenceMetricStrip>
  )
}
