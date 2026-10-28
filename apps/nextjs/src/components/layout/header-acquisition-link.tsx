"use client"

import { buttonVariants } from "@unprice/ui/button"
import { usePathname } from "next/navigation"
import { AcquisitionLink } from "~/components/landing/acquisition-link"
import { intentForMarketingPath } from "~/lib/signup-funnel"

// The header CTA follows the page under it: on /budgets it starts the Budgets setup and says so,
// everywhere else it is the paid-action proof.
export function HeaderAcquisitionLink() {
  const intent = intentForMarketingPath(usePathname())
  const isBudgets = intent === "budgets"

  return (
    <AcquisitionLink
      source="header"
      intent={intent}
      className={buttonVariants({
        variant: "outline",
        className: "h-9 gap-1.5 whitespace-nowrap px-2.5 text-xs sm:px-3 sm:text-sm",
      })}
    >
      <span className="sm:hidden">{isBudgets ? "Get a key" : "Start now"}</span>
      <span className="hidden sm:inline">
        {isBudgets ? "Get an API key" : "Start with one agent action"}
      </span>
    </AcquisitionLink>
  )
}
