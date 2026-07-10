import type { ReactNode } from "react"
import FooterMarketing from "~/components/layout/footer-marketing"
import HeaderMarketing from "~/components/layout/header-marketing"

export default function MarketingLayout(props: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-page">
      <HeaderMarketing />
      <main className="hide-scrollbar flex-1 overflow-y-auto">{props.children}</main>
      <FooterMarketing />
    </div>
  )
}
