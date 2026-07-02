import type { ReactNode } from "react"

import { cn } from "@unprice/ui/utils"

type SectionIntroProps = {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}

export function SectionIntro({ title, description, actions, className }: SectionIntroProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 px-1 py-4 md:flex-row md:items-start md:justify-between",
        className
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <h2 className="font-semibold text-base leading-none">{title}</h2>
        {description ? (
          <p className="max-w-3xl text-muted-foreground text-sm">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}
