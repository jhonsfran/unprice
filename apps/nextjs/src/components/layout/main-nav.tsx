import { cn, focusRing } from "@unprice/ui/utils"
import { navItems } from "~/constants/layout"
import { SuperLink } from "../super-link"

export function MainNav({
  isMarketing = false,
  isDashboard = false,
  className,
}: { isMarketing?: boolean; isDashboard?: boolean; className?: string }) {
  const marketingItems = navItems.filter((item) => (isMarketing ? item.isMarketing : true))
  const dashboardItems = navItems.filter((item) => (isDashboard ? item.isDashboard : true))

  const items = isMarketing ? marketingItems : dashboardItems

  return (
    <nav className={cn("items-center space-x-2", className ?? "hidden lg:flex")}>
      {items.map((item, idx) => (
        <SuperLink
          href={item.href}
          key={`${item.href}-${idx}-${item.target}`}
          className={cn(
            "rounded-md px-2 py-1.5 font-medium text-sm transition-colors hover:text-background-textContrast",
            focusRing
          )}
          target={item.target}
        >
          {item.title}
        </SuperLink>
      ))}
    </nav>
  )
}
