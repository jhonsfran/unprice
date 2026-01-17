import { cn, focusRing } from "@unprice/ui/utils"
import { navItems } from "~/constants/layout"
import { SuperLink } from "../super-link"

export function MainNav({ isMarketing = false }: { isMarketing?: boolean }) {
  return (
    <nav className="hidden items-center space-x-2 md:flex">
      {navItems
        .filter((item) => (isMarketing ? item.isMarketing : true))
        .map((item, idx) => (
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
