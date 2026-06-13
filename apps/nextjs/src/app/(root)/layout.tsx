import { cn } from "@unprice/ui/utils"
import { Analytics } from "@vercel/analytics/react"
import { SpeedInsights } from "@vercel/speed-insights/next"
import type { Metadata, Viewport } from "next"
import { ViewTransitions } from "next-view-transitions"

import "~/styles/globals.css"

import { VercelToolbar } from "@vercel/toolbar/next"
import { TailwindIndicator } from "~/components/layout/tailwind-indicator"
import { ThemeProvider } from "~/components/layout/theme-provider"
import { siteConfig } from "~/constants/layout"
import { fontMapper } from "~/styles/fonts"

export const metadata = {
  title: {
    default: siteConfig.name,
    template: `%s - ${siteConfig.name}`,
  },
  description: siteConfig.description,
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://unprice.dev",
    siteName: siteConfig.name,
    images: [
      {
        url: "/og",
        width: 1200,
        height: 630,
        alt: siteConfig.name,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.name,
    description: siteConfig.description,
    images: [{ url: "/og", width: 1200, height: 630, alt: siteConfig.name }],
    creator: "@jhosef90",
  },
  metadataBase: new URL("https://unprice.dev"),
  alternates: {
    canonical: "https://unprice.dev",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
} satisfies Metadata

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "white" },
    { media: "(prefers-color-scheme: dark)", color: "black" },
  ],
}

export default function RootLayout(props: { children: React.ReactNode }) {
  const shouldInjectToolbar = process.env.NODE_ENV === "development"

  return (
    <ViewTransitions>
      <html lang="en" suppressHydrationWarning>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          {/* Resource hints for external domains */}
          <link rel="preconnect" href="https://vercel.live" />
          <link rel="dns-prefetch" href="https://vercel.live" />
          <link rel="preconnect" href="https://vitals.vercel-insights.com" />
          <link rel="dns-prefetch" href="https://vitals.vercel-insights.com" />
          <link rel="preconnect" href="https://cdn.userjot.com" />
          <link rel="dns-prefetch" href="https://cdn.userjot.com" />
          {/* <script src="https://unpkg.com/react-scan/dist/auto.global.js" /> */}
        </head>
        <body
          className={cn(
            "antialiased",
            fontMapper["font-primary"],
            fontMapper["font-secondary"],
            fontMapper["font-mono"]
          )}
        >
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            {props.children}
            {shouldInjectToolbar && <VercelToolbar />}
          </ThemeProvider>
          {/* <Analytics /> */}
          <Analytics />
          <SpeedInsights />
          <TailwindIndicator />
        </body>
      </html>
    </ViewTransitions>
  )
}
