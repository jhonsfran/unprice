// See https://typeofweb.hashnode.dev/nextjs-prefetch-onmouseenter for a detailed explanation and more code
// See it in action: https://demo.yournextstore.com
"use client"

import { cn, focusRing } from "@unprice/ui/utils"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { forwardRef } from "react"

interface SuperLinkProps extends React.ComponentPropsWithoutRef<typeof Link> {
  children: React.ReactNode
}

const SuperLink = forwardRef<HTMLAnchorElement, SuperLinkProps>(({ children, ...props }, ref) => {
  const router = useRouter()
  const strHref = typeof props.href === "string" ? props.href : props.href.href

  const conditionalPrefetch = () => {
    if (strHref) {
      void router.prefetch(strHref)
    }
  }

  return (
    <Link
      ref={ref}
      className={cn("cursor-pointer", focusRing, props.className)}
      prefetch={false}
      scroll={false}
      {...props}
      onMouseEnter={(e) => {
        conditionalPrefetch()
        return props.onMouseEnter?.(e)
      }}
      onPointerEnter={(e) => {
        conditionalPrefetch()
        return props.onPointerEnter?.(e)
      }}
      onTouchStart={(e) => {
        conditionalPrefetch()
        return props.onTouchStart?.(e)
      }}
      onFocus={(e) => {
        conditionalPrefetch()
        return props.onFocus?.(e)
      }}
    >
      {children}
    </Link>
  )
})

SuperLink.displayName = "SuperLink"

export { SuperLink }
