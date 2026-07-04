"use client"

import { cn, focusRing } from "@unprice/ui/utils"

import { usePathname } from "next/navigation"
import { Ping } from "~/components/ping"
import { SuperLink } from "../super-link"

export function Tab({
  disabled,
  isNew,
  href,
  baseUrl,
  children,
  hasSubmenu,
}: {
  disabled?: boolean
  isNew?: boolean
  href: string
  baseUrl: string
  hasSubmenu?: boolean
  children: React.ReactNode
}) {
  const pathname = usePathname()

  const isActive = (itemHref: string) => {
    const active = baseUrl + itemHref === pathname
    const relativePath = pathname.replace(baseUrl, "")

    // active paths like /settings/danger or /settings
    if (active) {
      return true
    }

    // root paths
    if (itemHref === "/") {
      return pathname === baseUrl
    }

    // nested paths like /pages/page_id/edit
    return !hasSubmenu && relativePath.startsWith(itemHref)
  }

  return (
    <SuperLink
      className={cn(
        "flex items-center gap-x-2.5 rounded-md px-2 py-1.5 font-medium text-sm transition-all duration-200 hover:text-background-textContrast",
        focusRing,
        {
          "cursor-not-allowed opacity-80": disabled,
          "bg-background-bgHover text-background-textContrast": isActive(href),
          transparent: !isActive(href),
        }
      )}
      href={disabled ? "#" : baseUrl + href}
      aria-disabled={disabled}
      prefetch={false}
    >
      {children}

      <div className="relative h-5 w-1">
        {isNew && (
          <div className="absolute top-1 right-1">
            <Ping />
          </div>
        )}
      </div>
    </SuperLink>
  )
}

export function ShortLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <SuperLink
      href={href}
      className={cn(
        "flex items-center gap-x-2.5 rounded-md px-2 py-1.5 font-medium text-xs transition hover:text-background-textContrast",
        focusRing
      )}
    >
      {children}
    </SuperLink>
  )
}
