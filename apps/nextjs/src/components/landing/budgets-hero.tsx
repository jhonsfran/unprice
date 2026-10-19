import { buttonVariants } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"
import Balancer from "react-wrap-balancer"
import { AcquisitionLink } from "./acquisition-link"
import { BUDGETS_INSTALL } from "./budgets-snippets"
import { BudgetsVideo } from "./budgets-video"
import CopyToClipboard from "./copy-to-clipboard"

// The Budgets page opens on the launch video's own words, so a reader who
// arrives from it lands on the promise they just heard (message match,
// marketing-framework.md). The video itself sits beside the headline, so a
// reader who skipped it can watch it without scrolling. One way in: the key,
// with the install line under it.

export function InstallCommand({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-background-border bg-surface-panel py-1 pr-1 pl-3",
        className
      )}
    >
      <span aria-hidden className="select-none font-mono text-background-text text-xs">
        $
      </span>
      <code className="font-mono text-background-textContrast text-xs">{BUDGETS_INSTALL}</code>
      <CopyToClipboard code={BUDGETS_INSTALL} variant="ghost" className="size-7" />
    </div>
  )
}

export function BudgetsHero() {
  return (
    <section
      aria-labelledby="budgets-hero-title"
      className="ledger-dots mx-auto flex min-h-[calc(100svh-4rem)] w-full max-w-6xl flex-col justify-center px-6 py-12"
    >
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] lg:gap-14">
        <div className="flex flex-col items-start">
          <p className="font-mono text-background-text text-sm uppercase tracking-widest">
            Unprice Budgets
          </p>
          <h1
            id="budgets-hero-title"
            className="mt-5 font-primary text-background-textContrast text-display-1"
          >
            <Balancer>
              <span className="text-background-text">Hard caps.</span> Per key. Actually hard.
            </Balancer>
          </h1>
          <p className="mt-6 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Put a budget in front of your agent. Every paid call checks it first, and a call the cap
            cannot cover never reaches the provider. Your billing stays where it is.
          </p>
          <AcquisitionLink
            source="budgets_hero"
            intent="budgets"
            className={buttonVariants({ variant: "primary", className: "mt-10 gap-1.5" })}
          >
            Get an API key
          </AcquisitionLink>
          <InstallCommand className="mt-6" />
        </div>

        <BudgetsVideo />
      </div>
    </section>
  )
}
