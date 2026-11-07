"use client"

import { Check, ChevronsUpDown, GitBranch } from "lucide-react"
import { usePathname } from "next/navigation"

import { Button } from "@unprice/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { cn } from "@unprice/ui/utils"

import { SuperLink } from "~/components/super-link"
import { getStatusTone, statusToneClasses } from "~/lib/status-tones"

type Version = {
  id: string
  version: number
  status: "draft" | "published" | null
  latest: boolean | null
  active: boolean | null
  subscriptions: number
}

/**
 * The version's sections as underlined tabs, and a switcher that names the version being edited
 * and opens the others. Tabs and a dropdown read as clickable where plain chips did not.
 */
export function VersionNav({
  currentId,
  baseHref,
  versions,
  featureCount,
}: {
  currentId: string
  baseHref: string
  versions: Version[]
  featureCount: number
}) {
  const pathname = usePathname()
  const versionHref = `${baseHref}/${currentId}`
  const tabs = [
    { label: "Features", href: versionHref, count: featureCount },
    { label: "Prices", href: `${versionHref}/prices`, count: null },
  ]

  return (
    <div className="flex items-end justify-between gap-3 border-b">
      <TabNavigation className="w-auto border-b-0" aria-label="Version sections">
        {tabs.map((tab) => (
          <TabNavigationLink
            key={tab.label}
            asChild
            active={
              tab.href === versionHref ? pathname === versionHref : pathname.startsWith(tab.href)
            }
          >
            <SuperLink href={tab.href}>
              {tab.label}
              {tab.count !== null && (
                <span className="ml-1.5 rounded-full bg-background-bgHover px-1.5 py-px font-normal text-muted-foreground text-xs tabular-nums">
                  {tab.count}
                </span>
              )}
            </SuperLink>
          </TabNavigationLink>
        ))}
      </TabNavigation>
      <VersionSwitcher currentId={currentId} baseHref={baseHref} versions={versions} />
    </div>
  )
}

function statusOf(version: Version): string {
  return version.active === false ? "inactive" : (version.status ?? "draft")
}

function StatusDot({ version }: { version: Version }) {
  const dot = statusToneClasses[getStatusTone(statusOf(version))].dot
  return <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden="true" />
}

function VersionSwitcher({
  currentId,
  baseHref,
  versions,
}: {
  currentId: string
  baseHref: string
  versions: Version[]
}) {
  // Newest first, as a version list reads.
  const sorted = [...versions].sort((a, b) => b.version - a.version)
  const current = sorted.find((v) => v.id === currentId)
  if (!current) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="mb-2 h-7 gap-1.5 px-2 font-normal text-xs">
          <GitBranch className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-muted-foreground">Version</span>
          <span className="font-medium font-mono tabular-nums">v{current.version}</span>
          <span className="text-muted-foreground">{statusOf(current)}</span>
          <ChevronsUpDown className="size-3 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
          {sorted.length === 1 ? "This plan has one version" : `${sorted.length} versions`}
        </DropdownMenuLabel>
        {sorted.map((v) => (
          <DropdownMenuItem key={v.id} asChild className="cursor-pointer gap-2">
            <SuperLink href={`${baseHref}/${v.id}`}>
              <StatusDot version={v} />
              <span className="font-mono text-xs tabular-nums">v{v.version}</span>
              <span className="text-muted-foreground text-xs">{statusOf(v)}</span>
              {v.latest && (
                <span className="rounded-sm bg-background-bgHover px-1 text-[10px] text-muted-foreground uppercase tracking-wide">
                  latest
                </span>
              )}
              <span className="ml-auto text-muted-foreground text-xs tabular-nums">
                {v.subscriptions > 0 ? `${v.subscriptions} subs` : null}
              </span>
              {v.id === currentId && <Check className="size-3.5" aria-label="Current" />}
            </SuperLink>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="cursor-pointer text-xs">
          <SuperLink href={baseHref}>All versions</SuperLink>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
