import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Typography } from "@unprice/ui/typography"
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
      description: "Purchased plus granted funds",
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
      description: "Plan, trial, promo, or manual credits",
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
      label: "Consumed",
      description: "Already spent from the wallet",
      amount: wallet.balances.consumed,
      variant: "secondary",
    },
  ]

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      {balances.map((balance) => (
        <div key={balance.label} className="rounded-md border bg-background p-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <Typography variant="p" affects="removePaddingMargin" className="font-medium">
                {balance.label}
              </Typography>
              <Badge variant={balance.variant}>{wallet.currency}</Badge>
            </div>
            <Typography variant="h4" affects="removePaddingMargin">
              {formatWalletMoney(balance.amount, wallet.currency)}
            </Typography>
            <Typography
              variant="p"
              affects="removePaddingMargin"
              className="text-muted-foreground text-xs"
            >
              {balance.description}
            </Typography>
          </div>
        </div>
      ))}
    </div>
  )
}
