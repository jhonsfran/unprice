import { allEndpointsProcedures } from "@unprice/trpc/routes"
import { TooltipProvider } from "@unprice/ui/tooltip"
import { Provider } from "jotai"
import Script from "next/script"
import { NuqsAdapter } from "nuqs/adapters/next/app"
import type { ReactNode } from "react"
import { ToasterProvider } from "~/components/layout/theme-provider"
import { env } from "~/env"
import { TRPCReactProvider } from "~/trpc/client"

export default async function DashboardLayout({
  breadcrumbs,
  sidebar,
  header,
  children,
}: {
  children: ReactNode
  breadcrumbs: ReactNode
  sidebar: ReactNode
  header: ReactNode
}) {
  const userJotOptions = {
    widget: true,
    theme: "auto",
    position: process.env.NODE_ENV === "development" ? "left" : "right",
  }

  return (
    <div className="min-h-screen overflow-hidden ">
      <Script id="userjot-init" strategy="afterInteractive">
        {`
          window.$ujq=window.$ujq||[];
          window.uj=window.uj||new Proxy({},{get:(_,p)=>(...a)=>window.$ujq.push([p,...a])});
          const s = document.createElement('script');
          Object.assign(s, {
            src: 'https://cdn.userjot.com/sdk/v2/uj.js',
            type: 'module',
            async: true,
            onload: () => {
              window.dispatchEvent(new CustomEvent('uj:ready'));
            }
          });
          document.head.appendChild(s);
          window.uj.init("${env.USERJOT_ID}", ${JSON.stringify(userJotOptions)});
        `}
      </Script>
      <NuqsAdapter>
        <TRPCReactProvider allEndpointsProcedures={allEndpointsProcedures}>
          <TooltipProvider delayDuration={300}>
            <Provider>
              <div className="flex h-screen flex-col overflow-hidden lg:flex-row">
                {sidebar}
                <main className="flex w-full flex-1 flex-col overflow-hidden">
                  {header}
                  {breadcrumbs}
                  <div className="hide-scrollbar flex-grow overflow-y-auto">{children}</div>
                </main>
              </div>
            </Provider>
          </TooltipProvider>
        </TRPCReactProvider>
        <ToasterProvider />
      </NuqsAdapter>
    </div>
  )
}
