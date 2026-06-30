"use client"

import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { usePathname } from "next/navigation"
import { SuperLink } from "~/components/super-link"

const tabs = [
  { label: "Overview", href: "" },
  { label: "Wallets & Credits", href: "/wallet" },
  { label: "Runs", href: "/runs" },
  { label: "Subscriptions", href: "/subscriptions" },
  { label: "Invoices", href: "/invoices" },
] as const

export function CustomerTabs({ baseUrl }: { baseUrl: string }) {
  const pathname = usePathname()

  return (
    <TabNavigation>
      <div className="flex items-center overflow-x-auto">
        {tabs.map((tab) => {
          const href = `${baseUrl}${tab.href}`
          const active = tab.href === "" ? pathname === baseUrl : pathname.startsWith(href)

          return (
            <TabNavigationLink key={tab.label} asChild active={active}>
              <SuperLink href={href}>{tab.label}</SuperLink>
            </TabNavigationLink>
          )
        })}
      </div>
    </TabNavigation>
  )
}
