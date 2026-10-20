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
  return <Badge variant={status === "open" ? "success" : "secondary"}>{status}</Badge>
}
