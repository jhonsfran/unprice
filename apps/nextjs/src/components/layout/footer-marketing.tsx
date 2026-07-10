import { DOCS_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Skeleton } from "@unprice/ui/skeleton"
import { Link } from "next-view-transitions"
import dynamic from "next/dynamic"
import { LedgerRow } from "~/components/landing/station"
import { Logo } from "~/components/layout/logo"
import { siteConfig } from "~/constants/layout"

const ThemeToggle = dynamic(() => import("~/components/layout/theme-toggle"), {
  ssr: false,
  loading: () => (
    <Button variant="ghost" size="sm" className="button-ghost">
      <Skeleton className="h-6 w-6 rounded-full" />
    </Button>
  ),
})

// The footer is the page's colophon, set in the same receipt grammar as the
// sections above it: the mechanism sentence, three true facts as ledger rows,
// and only links that exist. No invented legal pages, no "Inc." — Unprice is
// an open-source project, and the footer says exactly that and nothing more.

const linkGroups: {
  label: string
  links: { title: string; href: string; external?: boolean }[]
}[] = [
  {
    label: "Read",
    links: [
      { title: "Manifesto", href: "/manifesto" },
      { title: "Docs", href: `${DOCS_DOMAIN}`, external: true },
    ],
  },
  {
    label: "Source",
    links: [
      { title: "GitHub", href: siteConfig.links.github, external: true },
      {
        title: "License · AGPL-3.0",
        href: `${siteConfig.links.github}/blob/main/LICENSE`,
        external: true,
      },
    ],
  },
  {
    label: "Talk",
    links: [
      {
        title: "seb@unprice.dev",
        href: "mailto:seb@unprice.dev?subject=What%20runs%20when%20customers%20overspend%3F",
      },
      { title: "@jhosef90 on X", href: siteConfig.links.twitter, external: true },
      { title: "Feedback", href: "https://unprice.userjot.com/", external: true },
    ],
  },
]

const footerFacts = [
  { label: "license", fact: "AGPL-3.0 · open source" },
  { label: "status", fact: "early access · free" },
  { label: "payments", fact: "your Stripe account" },
]

export default function FooterMarketing() {
  return (
    <footer className="border-t bg-surface-page">
      <div className="relative mx-auto w-full max-w-6xl border-[color:var(--rail)] px-6 pt-14 pb-8 lg:border-x">
        {/* Registration marks where the footer rule crosses the rails — the
            sheet's last crossing, same as SectionShell. */}
        <span
          aria-hidden
          className="-top-[7px] -left-[4.5px] absolute hidden select-none bg-surface-page font-mono text-[11px] text-background-border leading-none lg:block"
        >
          +
        </span>
        <span
          aria-hidden
          className="-top-[7px] -right-[4.5px] absolute hidden select-none bg-surface-page font-mono text-[11px] text-background-border leading-none lg:block"
        >
          +
        </span>

        <div className="grid gap-12 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-16">
          <div className="flex max-w-sm flex-col items-start">
            <Logo size="md" />
            <p className="mt-4 text-background-text text-sm leading-6">
              Authorize customer spend before paid work runs. The open-source customer money path
              for usage-based SaaS.
            </p>
            <div className="mt-6 flex w-full flex-col border-background-border border-t pt-2">
              {footerFacts.map((row) => (
                <LedgerRow
                  key={row.label}
                  label={row.label}
                  fact={row.fact}
                  variant="ghost"
                  labelClassName="text-xs"
                />
              ))}
            </div>
          </div>

          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3 md:justify-items-end"
          >
            {linkGroups.map((group) => (
              <div key={group.label} className="flex flex-col items-start">
                <span className="font-mono text-background-text text-xs uppercase tracking-widest">
                  {group.label}
                </span>
                <ul className="mt-4 flex flex-col gap-2.5">
                  {group.links.map((link) =>
                    link.external ? (
                      <li key={link.title}>
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noreferrer"
                          className="text-background-text text-sm leading-6 transition-colors hover:text-background-textContrast"
                        >
                          {link.title}
                        </a>
                      </li>
                    ) : (
                      <li key={link.title}>
                        <Link
                          href={link.href}
                          className="text-background-text text-sm leading-6 transition-colors hover:text-background-textContrast"
                        >
                          {link.title}
                        </Link>
                      </li>
                    )
                  )}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="mt-12 flex items-center justify-between gap-4 border-background-border border-t pt-4">
          <p className="text-background-text text-xs leading-6">
            © {new Date().getFullYear()} Unprice · open source under AGPL-3.0
          </p>
          <ThemeToggle />
        </div>
      </div>
    </footer>
  )
}
