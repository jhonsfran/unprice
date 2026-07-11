import { Link } from "next-view-transitions"
import dynamic from "next/dynamic"

import { Button } from "@unprice/ui/button"
import { GitHub, Twitter } from "@unprice/ui/icons"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { siteConfig } from "~/constants/layout"

const ThemeToggle = dynamic(() => import("~/components/layout/theme-toggle"), {
  ssr: false,
  loading: () => (
    <Button variant="ghost" size="sm" className="button-ghost">
      <Skeleton className="h-6 w-6 rounded-full" />
    </Button>
  ),
})

export default function Footer(props: { className?: string }) {
  return (
    <footer
      className={cn(
        "z-30 mx-auto flex h-16 w-full items-center justify-between gap-4 border-t bg-background-bgSubtle px-6 md:flex-row md:py-0",
        props.className
      )}
    >
      <div className="flex items-center gap-4 md:flex-row md:gap-2 md:px-0">
        <p className="text-sm leading-5" suppressHydrationWarning>
          &copy; {new Date().getFullYear()} Unprice
        </p>
      </div>

      <div className="flex flex-1 items-center justify-end">
        <nav className="flex items-center">
          {/* // TODO: add command for the most important actions in the platform - dev exp focused */}
          <Link href={siteConfig.links.twitter} target="_blank" rel="noreferrer">
            <Button variant="ghost" size="sm" className="button-ghost">
              <Twitter className="h-5 w-5 fill-current hover:text-background-textContrast" />
              <span className="sr-only">Twitter</span>
            </Button>
          </Link>
          <Link href={siteConfig.links.github} target="_blank" rel="noreferrer">
            <Button variant="ghost" size="sm" className="button-ghost">
              <GitHub className="h-5 w-5 fill-current hover:text-background-textContrast" />
              <span className="sr-only">GitHub</span>
            </Button>
          </Link>

          <ThemeToggle />
        </nav>
      </div>
    </footer>
  )
}
