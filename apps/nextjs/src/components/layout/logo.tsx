import UnpriceLogo from "@unprice/ui/unprice"
import { cn, focusRing } from "@unprice/ui/utils"
import { SuperLink } from "../super-link"

export function Logo({
  className = "",
  size = "md",
}: { className?: string; size?: "xs" | "sm" | "md" | "lg" | "xl" }) {
  return (
    <SuperLink
      href="/"
      className={cn("flex items-center justify-start text-primary-text", focusRing)}
    >
      <UnpriceLogo className={cn(className, "dark:hidden")} size={size} theme="light" />
      <UnpriceLogo className={cn(className, "hidden dark:flex")} size={size} theme="dark" />
    </SuperLink>
  )
}
