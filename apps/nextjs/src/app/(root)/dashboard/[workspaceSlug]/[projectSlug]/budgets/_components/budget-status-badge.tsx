import type { BudgetCatalogRow } from "@unprice/db/validators"
import { Badge } from "@unprice/ui/badge"
import { formatDistanceToNowStrict } from "date-fns"
import { formatDate } from "~/lib/dates"

export function BudgetStatusBadge({
  status,
  closesAt,
}: Pick<BudgetCatalogRow, "status" | "closesAt">) {
  if (status === "closing" && closesAt !== null) {
    return (
      <Badge variant="warning" title={formatDate(closesAt, "UTC", "yyyy-MM-dd HH:mm:ss 'UTC'")}>
        <span suppressHydrationWarning>
          closes {formatDistanceToNowStrict(closesAt, { addSuffix: true })}
        </span>
      </Badge>
    )
  }
  // the healthy state stays quiet; only closed earns a chip
  if (status === "open") {
    return (
      <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
        <span aria-hidden className="size-1.5 rounded-full bg-success-solid" />
        open
      </span>
    )
  }
  return <Badge variant="secondary">{status}</Badge>
}
