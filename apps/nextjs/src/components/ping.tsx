import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

import { cn } from "@unprice/ui/utils"

const variants = cva("", {
  variants: {
    variant: {
      default: "dark:bg-primary bg-[#ab6400]",
      destructive: "bg-destructive",
      secondary: "bg-secondary",
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

export function Ping(props: VariantProps<typeof variants>) {
  return (
    <span className="flex h-[5px] w-[5px]">
      <span
        className={cn(
          variants({ variant: props.variant }),
          "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
        )}
      />
      <span
        className={cn(
          variants({ variant: props.variant }),
          "relative inline-flex h-[5px] w-[5px] rounded-full"
        )}
      />
    </span>
  )
}
