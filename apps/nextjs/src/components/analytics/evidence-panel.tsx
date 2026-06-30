import { cn } from "@unprice/ui/utils"
import type { ReactNode } from "react"

type EvidenceSectionProps = {
  title: ReactNode
  description?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  isRefreshing?: boolean
  className?: string
  contentClassName?: string
  titleClassName?: string
}

export function EvidenceSection({
  title,
  description,
  badges,
  actions,
  children,
  isRefreshing = false,
  className,
  contentClassName,
  titleClassName,
}: EvidenceSectionProps) {
  const titleIsText = typeof title === "string" || typeof title === "number"
  const descriptionIsText = typeof description === "string" || typeof description === "number"

  return (
    <section className={cn("relative", className)}>
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/55 to-transparent transition-opacity duration-300 motion-reduce:transition-none",
          isRefreshing ? "opacity-100" : "opacity-0"
        )}
      />
      <div
        className={cn(
          "transition-opacity duration-300 motion-reduce:transition-none",
          isRefreshing ? "opacity-90" : "opacity-100"
        )}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {titleIsText ? (
                <h2 className={cn("font-semibold text-lg leading-none", titleClassName)}>
                  {title}
                </h2>
              ) : (
                <div className={cn("font-semibold text-lg leading-none", titleClassName)}>
                  {title}
                </div>
              )}
              {badges}
            </div>
            {description ? (
              descriptionIsText ? (
                <p className="text-muted-foreground text-sm">{description}</p>
              ) : (
                <div className="text-muted-foreground text-sm">{description}</div>
              )
            ) : null}
          </div>
          {actions}
        </div>
        {children ? (
          <div className={cn("mt-4 flex flex-col gap-4", contentClassName)}>{children}</div>
        ) : null}
      </div>
    </section>
  )
}

type EvidenceFrameProps = {
  children: ReactNode
  className?: string
  variant?: "solid" | "dashed"
  height?: "chart" | "table" | "none"
}

export function EvidenceFrame({
  children,
  className,
  variant = "solid",
  height = "chart",
}: EvidenceFrameProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border",
        variant === "solid" ? "border-border/60 bg-card/40" : "border-dashed bg-transparent",
        height === "chart" && "h-[220px]",
        height === "table" && "min-h-[520px]",
        className
      )}
    >
      {children}
    </div>
  )
}

type EvidenceMetricStripProps = {
  children: ReactNode
  className?: string
}

export function EvidenceMetricStrip({ children, className }: EvidenceMetricStripProps) {
  return (
    <div
      className={cn(
        "grid gap-px overflow-hidden rounded-md border border-border/60 bg-border/60",
        className
      )}
    >
      {children}
    </div>
  )
}

type EvidenceMetricTileProps = {
  label: ReactNode
  value: ReactNode
  helper?: ReactNode
  icon?: ReactNode
  tone?: "default" | "success" | "warning" | "destructive"
  className?: string
  valueClassName?: string
}

export function EvidenceMetricTile({
  label,
  value,
  helper,
  icon,
  tone = "default",
  className,
  valueClassName,
}: EvidenceMetricTileProps) {
  const labelIsText = typeof label === "string" || typeof label === "number"

  return (
    <div className={cn("bg-card/80 p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        {labelIsText ? (
          <p className="truncate text-muted-foreground text-xs">{label}</p>
        ) : (
          <div className="truncate text-muted-foreground text-xs">{label}</div>
        )}
        {icon ? (
          <div
            className={cn(
              "text-muted-foreground",
              tone === "success" && "text-success",
              tone === "warning" && "text-warning",
              tone === "destructive" && "text-danger"
            )}
          >
            {icon}
          </div>
        ) : null}
      </div>
      <div
        className={cn("mt-2 font-semibold text-foreground text-xl tabular-nums", valueClassName)}
      >
        {value}
      </div>
      {helper ? <div className="mt-1 truncate text-muted-foreground text-xs">{helper}</div> : null}
    </div>
  )
}
