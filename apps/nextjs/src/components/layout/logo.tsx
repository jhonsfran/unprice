import UnpriceLogo, { type UnpriceLogoProps } from "@unprice/ui/unprice"
import { cn, focusRing } from "@unprice/ui/utils"
import { SuperLink } from "../super-link"

export function Logo({ className = "", size = "md", variant = "full" }: UnpriceLogoProps) {
  return (
    <SuperLink
      href="/"
      className={cn("flex items-center justify-start text-primary-text", focusRing)}
    >
      <UnpriceLogo
        className={cn(className, "dark:hidden")}
        size={size}
        theme="light"
        variant={variant}
      />
      <UnpriceLogo
        className={cn(className, "hidden dark:flex")}
        size={size}
        theme="dark"
        variant={variant}
      />
    </SuperLink>
  )
}
