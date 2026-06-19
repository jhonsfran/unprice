import { BASE_URL, DOCS_DOMAIN, PRICING_DOMAIN } from "@unprice/config"
import type { SiteConfig } from "../types"

export const navItems = [
  {
    href: `${BASE_URL}/manifesto`,
    title: "Manifesto",
    isMarketing: true,
    isDashboard: false,
  },
  {
    href: "https://unprice.userjot.com/",
    title: "Feedback",
    target: "_blank",
    isMarketing: false,
    isDashboard: true,
  },
  {
    href: `${DOCS_DOMAIN}`,
    title: "Docs",
    isMarketing: true,
    isDashboard: true,
  },
  {
    href: `${PRICING_DOMAIN}/`,
    title: "Pricing",
    isMarketing: false,
    isDashboard: false,
  },
] satisfies {
  href: string
  title: string
  target?: string
  isMarketing?: boolean
  isDashboard?: boolean
}[]

export const siteConfig: SiteConfig = {
  name: "unprice",
  description: "PriceOps infrastructure for SaaS. Stop hardcoding your revenue.",
  links: {
    twitter: "https://github.com/jhonsfran1165/unprice",
    github: "https://github.com/jhonsfran1165/unprice",
    dashboard: "/",
  },
}
