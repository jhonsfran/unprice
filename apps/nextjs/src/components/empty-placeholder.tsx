import type * as React from "react"

import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Typography, type VariantKeyTypography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"

export function EmptyPlaceholder({
  className,
  children,
  isLoading = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  isLoading?: boolean
}) {
  return (
    <div
      className={cn(
        "relative flex h-full min-h-[500px] w-full items-center justify-center rounded-md border border-dashed",
        className
      )}
      {...props}
    >
      {isLoading ? (
        <LoadingAnimation className="size-6" />
      ) : (
        <div className="mx-auto flex w-full max-w-[80%] flex-col items-center justify-center text-center">
          {children}
        </div>
      )}
    </div>
  )
}

EmptyPlaceholder.Icon = function EmptyPlaceHolderIcon({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-center rounded-full text-muted-foreground opacity-30">
      {children}
    </div>
  )
}

type EmptyPlaceholderTitleProps = React.HTMLAttributes<HTMLHeadingElement> & {
  variant?: VariantKeyTypography
}

EmptyPlaceholder.Title = function EmptyPlaceholderTitle({
  className,
  children,
  variant = "h6",
  ...props
}: EmptyPlaceholderTitleProps) {
  return (
    <Typography
      variant={variant}
      // the title carries the page's key message: ink, not muted gray
      className={cn("mt-4 mb-2 font-medium text-background-textContrast", className)}
      {...props}
    >
      {children}
    </Typography>
  )
}

EmptyPlaceholder.Action = function EmptyPlaceHolderAction({
  children,
}: {
  children: React.ReactNode
}) {
  return <div className="flex items-center justify-center rounded-full">{children}</div>
}

type EmptyPlaceholderDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>

EmptyPlaceholder.Description = function EmptyPlaceholderDescription({
  className,
  children,
  ...props
}: EmptyPlaceholderDescriptionProps) {
  return (
    <Typography
      variant="p"
      affects="removePaddingMargin"
      // takes up to 80% of the width of the parent
      className={cn(
        "mb-4 w-full max-w-[80%] whitespace-normal break-words text-muted-foreground text-xs",
        className
      )}
      {...props}
    >
      {children}
    </Typography>
  )
}
