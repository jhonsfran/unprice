import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { CreditCard, FileText, Gauge, ShieldCheck, Wallet } from "lucide-react"
import { SuperLink } from "~/components/super-link"
import { formatWalletMoney } from "../../_components/wallet/format-wallet-money"

type SubscriptionsCustomer = RouterOutputs["customers"]["getSubscriptions"]["customer"]
type WalletData = RouterOutputs["customers"]["getWallet"]["wallet"]
type EntitlementsData = RouterOutputs["customers"]["getEntitlements"]["entitlements"]
type EconomicSummary = RouterOutputs["customers"]["getEconomicSummary"]

type CustomerMoneyPathSummaryProps = {
  baseUrl: string
  customer: SubscriptionsCustomer
  wallet: WalletData
  entitlements: EntitlementsData
  summary: EconomicSummary
}

export function CustomerMoneyPathSummary({
  baseUrl,
  customer,
  wallet,
  entitlements,
  summary,
}: CustomerMoneyPathSummaryProps) {
  const activeSubscriptions = customer.subscriptions.filter((subscription) => subscription.active)
  const available = wallet.balances.purchased + wallet.balances.granted

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <SummaryTile
        href={`${baseUrl}/subscriptions`}
        icon={<CreditCard className="size-4" />}
        title="Subscription"
        primary={activeSubscriptions.length === 0 ? "none" : `${activeSubscriptions.length} active`}
        secondary={`${customer.subscriptions.length} total`}
        tone={activeSubscriptions.length > 0 ? "success" : "warning"}
      />
      <SummaryTile
        href={`${baseUrl}/subscriptions`}
        icon={<ShieldCheck className="size-4" />}
        title="Entitlements"
        primary={`${entitlements.length} features`}
        secondary="access grants"
        tone={entitlements.length > 0 ? "success" : "warning"}
      />
      <SummaryTile
        href={`${baseUrl}/wallet`}
        icon={<Wallet className="size-4" />}
        title="Wallet"
        primary={formatWalletMoney(available, wallet.currency)}
        secondary={`${formatWalletMoney(wallet.balances.reserved, wallet.currency)} held`}
        tone={available > 0 ? "success" : "warning"}
      />
      <SummaryTile
        href={`${baseUrl}/runs`}
        icon={<Gauge className="size-4" />}
        title="Runs"
        primary={`${summary.runCounts.total} total`}
        secondary={`${summary.runCounts.running} running / ${summary.runCounts.budgetExceeded} budget exceeded`}
        tone={
          summary.runCounts.budgetExceeded > 0
            ? "destructive"
            : summary.runCounts.running > 0
              ? "warning"
              : "default"
        }
      />
      <SummaryTile
        href={`${baseUrl}/invoices`}
        icon={<FileText className="size-4" />}
        title="Invoices"
        primary={`${summary.invoiceCounts.total} total`}
        secondary={`${summary.invoiceCounts.paid} paid`}
        tone={
          summary.invoiceCounts.total === 0
            ? "default"
            : summary.invoiceCounts.paid > 0
              ? "success"
              : "warning"
        }
      />
    </div>
  )
}

function SummaryTile({
  href,
  icon,
  title,
  primary,
  secondary,
  tone,
}: {
  href: string
  icon: React.ReactNode
  title: string
  primary: string
  secondary: string
  tone: "default" | "success" | "warning" | "destructive"
}) {
  return (
    <SuperLink href={href} className="block">
      <Card className="h-full border-muted/60 transition-colors hover:border-primary/50 motion-reduce:transition-none">
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="font-medium text-sm">{title}</CardTitle>
          <span className="text-muted-foreground">{icon}</span>
        </CardHeader>
        <CardContent>
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-semibold text-lg">{primary}</p>
            <Badge variant={tone} className="shrink-0">
              {tone === "destructive" ? "attention" : tone}
            </Badge>
          </div>
          <p className="mt-1 truncate text-muted-foreground text-xs">{secondary}</p>
        </CardContent>
      </Card>
    </SuperLink>
  )
}
