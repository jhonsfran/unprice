import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

import { cn } from "@unprice/ui/utils"

const variants = cva("", {
  variants: {
    variant: {
      default: "dark:bg-primary bg-[#ab6400]",
      destructive: "bg-destructive",
      secondary: "bg-secondary",
      info: "bg-info",
      warning: "bg-warning",
      success: "bg-success",
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

export function Ping({
  variant,
  className,
}: VariantProps<typeof variants> & { className?: string }) {
  return (
    <span className="flex h-[5px] w-[5px]">
      <span
        className={cn(
          variants({ variant }),
          className,
          "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
        )}
      />
      <span
        className={cn(variants({ variant }), "relative inline-flex h-[5px] w-[5px] rounded-full")}
      />
    </span>
  )
}
