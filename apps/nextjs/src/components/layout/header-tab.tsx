import { Badge } from "@unprice/ui/badge"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { CopyButton } from "~/components/copy-button"

export default function HeaderTab({
  title,
  description,
  action,
  className,
  label,
  id,
}: {
  title?: string
  description?: string | null
  action?: React.ReactNode
  className?: string
  label?: string
  id?: string
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-between space-y-6 px-0 md:flex-row md:space-y-0",
        className
      )}
    >
      <div className="mr-auto space-y-2">
        <div className="flex items-center space-x-2">
          <Typography variant="h3">{title}</Typography>
          {label && (
            <Badge
              className={cn("ml-2 hidden md:flex", {
                info: ["active", "published"].includes(label),
                warning: ["pending"].includes(label),
                success: ["paid", "void"].includes(label),
                danger: ["inactive", "unpaid", "failed"].includes(label),
                default: ["archived", "draft"].includes(label),
              })}
            >
              <span
                className={cn("flex h-2 w-2 rounded-full", {
                  "bg-info-solid": ["active", "published"].includes(label),
                  "bg-warning-solid": ["pending"].includes(label),
                  "bg-success-solid": ["paid", "void"].includes(label),
                  "bg-danger-solid": ["inactive", "unpaid", "failed"].includes(label),
                  "bg-gray-solid": ["archived", "draft"].includes(label),
                })}
              />
              <span className="ml-1">{label}</span>
            </Badge>
          )}
          {id && <CopyButton value={id} />}
        </div>
        {description && (
          <Typography variant="normal" className="hidden text-background-solidHover md:flex">
            {description}
          </Typography>
        )}
      </div>
      <div className="ml-auto">{action}</div>
    </div>
  )
}
