import type { ReactNode } from "react"
import FooterMarketing from "~/components/layout/footer-marketing"
import HeaderMarketing from "~/components/layout/header-marketing"

export default function MarketingLayout(props: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-page">
      <HeaderMarketing />
      {/* The scrollbar stays: it is the only progress indicator on a long
          page, and hiding it costs the reader their sense of how much is
          left (launch audit 2026-07-27). */}
      <main className="flex-1 overflow-y-auto">{props.children}</main>
      <FooterMarketing />
    </div>
  )
}
