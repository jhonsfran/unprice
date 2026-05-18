import { Badge } from "@unprice/ui/badge"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { CopyButton } from "~/components/copy-button"
import { getStatusTone, statusToneClasses } from "~/lib/status-tones"

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
  const tone = getStatusTone(label)
  const toneClass = statusToneClasses[tone]

  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-between gap-6 px-0 md:flex-row",
        className
      )}
    >
      <div className="mr-auto flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Typography variant="h3">{title}</Typography>
          {label && (
            <Badge variant={toneClass.badgeVariant} className="hidden gap-1.5 md:flex">
              <span className={cn("size-2 rounded-full", toneClass.dot)} />
              <span>{label}</span>
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
