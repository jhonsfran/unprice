import { TooltipProvider } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import { ViewTransitions } from "next-view-transitions"
import { ThemeProvider, ToasterProvider } from "~/components/layout/theme-provider"
import { siteConfig } from "~/constants/layout"
import { fontMapper } from "~/styles/fonts"

import "~/styles/sites.css"
import { UpdateMarketingCookie } from "../(root)/auth/_components/update-marketing-cookie"

// TODO: get metadata from the site
export const metadata = {
  title: {
    default: siteConfig.name,
    template: `%s - ${siteConfig.name}`,
  },
  description: siteConfig.description,
  openGraph: {
    type: "website",
    locale: "en_US",
    images: [{ url: "/og" }],
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.name,
    description: siteConfig.description,
    images: [{ url: "/og" }], // TODO: auto generate og image for sites
    creator: "jhonsfran",
  },
  metadataBase: new URL("https://sites.unprice.dev"),
  robots: {
    index: true,
    follow: true,
  },
}

export default function SitesLayout(props: { children: React.ReactNode }) {
  return (
    <ViewTransitions>
      <html lang="en" suppressHydrationWarning>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        </head>
        <body
          className={cn(
            "min-h-screen antialiased",
            fontMapper["font-primary"],
            fontMapper["font-secondary"],
            fontMapper["font-mono"]
          )}
        >
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            <TooltipProvider delayDuration={300}>{props.children}</TooltipProvider>
          </ThemeProvider>

          <UpdateMarketingCookie />
          <ToasterProvider />
        </body>
      </html>
    </ViewTransitions>
  )
}
