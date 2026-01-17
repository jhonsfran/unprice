import { APP_DOMAIN } from "@unprice/config"
import { Badge } from "@unprice/ui/badge"
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
        "sticky top-0 z-40 flex h-16 items-center border-b bg-background-base px-2 shadow-sm backdrop-blur-[2px] sm:px-12"
      )}
    >
      <div className="flex h-14 w-full items-center space-x-8 sm:justify-between sm:space-x-0">
        <div className="flex items-center justify-start">
          <Logo size="md" />{" "}
          <Badge variant="outline" className="mt-1 ml-2">
            alpha
          </Badge>
        </div>

        <div className="flex flex-1 items-center justify-end space-x-2">
          <MainNav isMarketing={true} />
          <div className="ml-auto flex items-center pl-8">
            <Link
              href={`${APP_DOMAIN}`}
              className={cn(buttonVariants({ variant: "primary" }), "border-primary-solid")}
            >
              Login
              <ChevronRight className="ml-1 h-4 w-4" />
            </Link>
          </div>
        </div>
      </div>
    </header>
  )
}
