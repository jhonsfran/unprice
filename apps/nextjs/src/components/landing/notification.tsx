import { cn } from "@unprice/ui/utils"
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"
import type { ReactNode } from "react"

type Notification = {
  name: string
  description: string
  icon: ReactNode
  iconClassName?: string
  time: string
  href?: string
}
const notificationVariants = cva(
  cn(
    "relative mx-auto min-h-fit w-full max-w-[400px] cursor-pointer overflow-hidden rounded-2xl p-4",
    // animation styles
    "transition-all duration-200 ease-in-out hover:scale-[103%]",
    // light styles
    "[box-shadow:0_0_0_1px_rgba(0,0,0,.03),0_2px_4px_rgba(0,0,0,.05),0_12px_24px_rgba(0,0,0,.05)]",
    // dark styles
    "transform-gpu dark:bg-transparent dark:backdrop-blur-md dark:[border:1px_solid_rgba(255,255,255,.1)] dark:[box-shadow:0_-20px_80px_-20px_#ffffff1f_inset]"
  ),
  {
    variants: {
      size: {
        default: "p-4",
        sm: "p-2",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

export interface NotificationProps
  extends Notification,
    VariantProps<typeof notificationVariants> {}

export const Notification = ({
  name,
  description,
  icon,
  iconClassName,
  time,
  size,
}: NotificationProps) => {
  return (
    <figure className={cn(notificationVariants({ size }))}>
      <div
        className={cn("flex flex-row items-center gap-3", {
          "gap-2": size === "sm",
        })}
      >
        <div
          className={cn(
            "flex size-10 items-center justify-center rounded-2xl text-white",
            { "size-8": size === "sm" },
            iconClassName
          )}
        >
          {icon}
        </div>
        <div className="flex flex-col overflow-hidden">
          <figcaption
            className={cn("flex flex-row items-center whitespace-pre font-medium text-lg", {
              "text-sm": size === "sm",
            })}
          >
            <span
              className={cn("text-lg", {
                "text-sm": size === "sm",
              })}
            >
              {name}
            </span>
            <span className="mx-1">·</span>
            <span
              className={cn("text-background-solid text-sm", {
                "text-xs": size === "sm",
              })}
            >
              {time}
            </span>
          </figcaption>
          <p
            className={cn("line-clamp-1 font-normal text-background-solid text-sm", {
              "text-xs": size === "sm",
            })}
          >
            {description}
          </p>
        </div>
      </div>
    </figure>
  )
}
