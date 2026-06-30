import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import HeaderTab from "~/components/layout/header-tab"
import { CustomerActions } from "../../_components/customers/customer-actions"
import { formatWalletMoney } from "../../_components/wallet/format-wallet-money"

type Customer = RouterOutputs["customers"]["getSubscriptions"]["customer"]
type Wallet = RouterOutputs["customers"]["getWallet"]["wallet"]

export function CustomerEconomicHeader({
  customer,
  wallet,
}: {
  customer: Customer
  wallet: Wallet
}) {
  const activeSubscriptions = customer.subscriptions.filter((subscription) => subscription.active)
  const activePlanLabel =
    activeSubscriptions.length === 0
      ? "No active plan"
      : activeSubscriptions.length === 1
        ? (activeSubscriptions[0]?.planSlug ?? "Active plan")
        : `${activeSubscriptions.length} active plans`
  const available = wallet.balances.purchased + wallet.balances.granted

  return (
    <HeaderTab
      title={customer.email}
      description={customer.description}
      label={customer.active ? "active" : "inactive"}
      id={customer.id}
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge variant="outline">{activePlanLabel}</Badge>
          <Badge variant={available > 0 ? "success" : "warning"}>
            Wallet {formatWalletMoney(available, wallet.currency)}
          </Badge>
          <CustomerActions customer={customer} />
        </div>
      }
    />
  )
}
