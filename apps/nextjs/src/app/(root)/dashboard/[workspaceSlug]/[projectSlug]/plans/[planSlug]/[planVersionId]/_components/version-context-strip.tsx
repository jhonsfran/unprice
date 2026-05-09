import { GitBranch } from "lucide-react"

import { cn } from "@unprice/ui/utils"

import { SuperLink } from "~/components/super-link"

type Version = {
  id: string
  version: number
  status: "draft" | "published" | null
  latest: boolean | null
  active: boolean | null
  subscriptions: number
}

export function VersionContextStrip({
  currentId,
  baseHref,
  versions,
}: {
  currentId: string
  baseHref: string
  versions: Version[]
}) {
  if (versions.length <= 1) return null
  // Newest first so the most relevant versions sit on the left.
  const sorted = [...versions].sort((a, b) => b.version - a.version)

  return (
    <nav
      aria-label="Plan versions"
      className="hide-scrollbar flex items-center gap-3 overflow-x-auto"
    >
      <div className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <GitBranch className="size-3.5" aria-hidden="true" />
        <span className="font-medium text-xs uppercase tracking-wider">Versions</span>
      </div>
      <div className="flex items-center gap-1">
        {sorted.map((v) => (
          <VersionChip
            key={v.id}
            version={v}
            href={`${baseHref}/${v.id}`}
            isCurrent={v.id === currentId}
          />
        ))}
      </div>
    </nav>
  )
}

function VersionChip({
  version: v,
  href,
  isCurrent,
}: {
  version: Version
  href: string
  isCurrent: boolean
}) {
  const status = v.status ?? "draft"
  const isInactive = v.active === false

  const dotClass = isInactive
    ? "bg-danger-solid"
    : v.latest
      ? "bg-success-solid"
      : status === "published"
        ? "bg-info-solid"
        : "bg-gray-solid"

  const inner = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 font-mono text-xs tabular-nums transition-colors",
        isCurrent
          ? "border-border bg-background-bgHover font-semibold text-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:bg-background-bgSubtle hover:text-foreground"
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", dotClass)} aria-hidden="true" />
      <span>v{v.version}</span>
      {v.latest && (
        <span className="font-normal font-sans text-[10px] text-success uppercase tracking-wide">
          latest
        </span>
      )}
    </span>
  )

  if (isCurrent) {
    return <span aria-current="page">{inner}</span>
  }

  return (
    <SuperLink
      href={href}
      prefetch={false}
      className="rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {inner}
    </SuperLink>
  )
}
