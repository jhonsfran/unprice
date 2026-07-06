import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { ChevronRight } from "@unprice/ui/icons"
import { cn } from "@unprice/ui/utils"
import { Link } from "next-view-transitions"
import { Logo } from "~/components/layout/logo"
import { MainNav } from "~/components/layout/main-nav"

export default function HeaderMarketing() {
  return (
    <header
      className={cn(
        "sticky top-0 z-40 flex h-16 items-center border-b bg-background-base px-4 shadow-sm backdrop-blur-[2px] sm:px-12"
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
            <Link
              href={`${APP_DOMAIN}`}
              className={buttonVariants({
                variant: "primary",
                className: "h-9 gap-1.5 whitespace-nowrap px-2.5 text-xs sm:px-3 sm:text-sm",
              })}
            >
              <span className="sm:hidden">Start action</span>
              <span className="hidden sm:inline">Start with one action</span>
              <ChevronRight data-icon="inline-end size-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </header>
  )
}
