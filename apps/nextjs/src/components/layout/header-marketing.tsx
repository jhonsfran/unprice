import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { GitHub } from "@unprice/ui/icons"
import { cn } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import { Logo } from "~/components/layout/logo"
import { MainNav } from "~/components/layout/main-nav"
import { siteConfig } from "~/constants/layout"

export default function HeaderMarketing() {
  return (
    <header
      className={cn(
        // Translucent material over the page, not opaque wallpaper: the blur
        // only exists because the background lets content show through it.
        "sticky top-0 z-40 border-b bg-[color:color-mix(in_srgb,var(--surface-page)_72%,transparent)] backdrop-blur-md"
      )}
    >
      {/* Same column as the sections below, so the header sits on the sheet's
          rails instead of floating full-bleed above them. */}
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-6">
        <div className="flex shrink-0 items-center justify-start">
          <div className="hidden min-[430px]:block">
            <Logo size="md" />
          </div>
          <div className="min-[430px]:hidden">
            <Logo size="lg" variant="icon" />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          <MainNav isMarketing={true} className="hidden md:flex" />
          {/* The repo is a proof surface — read the source is the argument. */}
          <a
            href={siteConfig.links.github}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({
              variant: "ghost",
              size: "icon",
              className: "shrink-0 text-background-text hover:text-background-textContrast",
            })}
          >
            <GitHub className="size-4 fill-current" />
            <span className="sr-only">Source on GitHub</span>
          </a>
          <div className="flex shrink-0 items-center pl-2 md:pl-4">
            {/* Outline here on purpose: the hero owns the solid amber primary.
                One amber signal per viewport, same scarcity law as the money
                path's decision dot. */}
            <Link
              href={`${APP_DOMAIN}`}
              className={buttonVariants({
                variant: "primary",
                className: "h-9 gap-1.5 whitespace-nowrap px-2.5 text-xs sm:px-3 sm:text-sm",
              })}
            >
              <span className="sm:hidden">Start free</span>
              <span className="hidden sm:inline">Start with one paid action</span>
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </header>
  )
}
