import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import { Logo } from "~/components/layout/logo"
import { MainNav } from "~/components/layout/main-nav"

export default function HeaderMarketing() {
  return (
    <header
      className={cn(
        // Translucent material over the page, not opaque wallpaper: the blur
        // only exists because the background lets content show through it.
        "sticky top-0 z-40 flex h-16 items-center border-b bg-[color:color-mix(in_srgb,var(--surface-page)_72%,transparent)] px-4 backdrop-blur-md sm:px-12"
      )}
    >
      <div className="flex h-14 w-full items-center justify-between gap-3">
        <div className="flex shrink-0 items-center justify-start">
          <div className="hidden min-[430px]:block">
            <Logo size="md" />
          </div>
          <div className="min-[430px]:hidden">
            <Logo size="lg" variant="icon" />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <MainNav isMarketing={true} />
          <div className="flex shrink-0 items-center lg:pl-8">
            {/* Outline here on purpose: the hero owns the solid amber primary.
                One amber signal per viewport, same scarcity law as the money
                path's decision dot. */}
            <Link
              href={`${APP_DOMAIN}`}
              className={buttonVariants({
                variant: "outline",
                className:
                  "h-9 gap-1.5 whitespace-nowrap bg-transparent px-2.5 text-xs sm:px-3 sm:text-sm",
              })}
            >
              <span className="sm:hidden">Start action</span>
              <span className="hidden sm:inline">Start with one action</span>
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </header>
  )
}
