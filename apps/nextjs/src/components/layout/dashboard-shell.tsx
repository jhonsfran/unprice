import type React from "react"

import { cn } from "@unprice/ui/utils"
import MaxWidthWrapper from "./max-width-wrapper"

export function DashboardShell(props: {
  children: React.ReactNode
  className?: string
  header?: React.ReactNode
  aside?: React.ReactNode
  /**
   * Opt-in: make the shell fill the dashboard content well's height on lg so a page
   * can flex-fill it (e.g. a workbench that must fit the viewport without the well
   * scrolling). Off by default — other pages keep their natural, well-scrolling height.
   */
  fullHeight?: boolean
}) {
  return (
    <MaxWidthWrapper
      className={cn("hide-scrollbar overflow-x-hidden", props.fullHeight && "lg:h-full")}
    >
      {!props.aside && (
        <div
          className={cn("flex min-h-0 flex-col", props.fullHeight && "lg:h-full", props.className)}
        >
          <div className="flex min-h-0 flex-1 flex-col space-y-6 px-0 md:space-y-8 md:py-4">
            {props.header && props.header}

            <div className="flex min-h-0 flex-1 flex-col space-y-8">{props.children}</div>
          </div>
        </div>
      )}

      {props.aside && (
        <div className={cn("flex min-h-0 flex-col gap-12 lg:flex-row", props.className)}>
          <div className="flex min-h-0 flex-1 flex-col space-y-6 px-0 md:space-y-8 md:py-4 lg:min-w-0">
            {props.header && props.header}

            <div className="flex min-h-0 flex-1 flex-col space-y-8">{props.children}</div>
          </div>
          <div className="flex flex-col lg:w-80 lg:shrink-0">{props.aside}</div>
        </div>
      )}
    </MaxWidthWrapper>
  )
}
