import { Dashboard } from "@unprice/ui/icons"
import { Activity, Calculator, Key, Link, Settings, Sticker, Users } from "lucide-react"
import type { DashboardRoute, Shortcut } from "~/types"

export const PROJECT_NAV: DashboardRoute[] = [
  {
    name: "Overview",
    icon: Dashboard,
    href: "/dashboard",
  },
  {
    name: "Events",
    icon: Activity,
    href: "/events",
  },
  {
    name: "Plans",
    icon: Calculator,
    href: "/plans",
    disabled: false,
    isNew: true,
    featureSlug: "plans",
  },
  {
    name: "Pages",
    icon: Sticker,
    href: "/pages",
    featureSlug: "pages",
  },
  {
    name: "API Keys",
    href: "/apikeys",
    icon: Key,
    featureSlug: "apikeys",
  },
  {
    name: "Customers",
    href: "/customers",
    icon: Users,
    featureSlug: "customers",
  },
  {
    name: "Settings",
    href: "/settings",
    icon: Settings,
    sidebar: [
      {
        name: "Danger",
        href: "/settings/danger",
      },
      {
        name: "Infrastructure",
        href: "/settings/payment",
      },
    ],
  },
]

export const PROJECT_SHORTCUTS: Shortcut[] = [
  {
    name: "View Plans",
    href: "plans",
    icon: Link,
    featureSlug: "plans",
  },
  {
    name: "Customer",
    href: "customers/subscriptions/new",
    icon: Link,
    featureSlug: "customers",
  },
  {
    name: "All Customers",
    href: "customers",
    icon: Link,
    featureSlug: "customers",
  },
]
