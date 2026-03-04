import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@unprice/ui/breadcrumb"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import { cn, focusRing } from "@unprice/ui/utils"
import { Fragment } from "react"
import { SuperLink } from "~/components/super-link"

export default function BreadcrumbsApp(props: {
  breadcrumbs: string[]
  baseUrl: string
  className?: string
}) {
  const { breadcrumbs, baseUrl } = props

  // the last section is always our "BreadcrumbPage", the remaining segments are our "BreadcrumbItems":
  const breadcrumbPage = breadcrumbs.pop()

  if (!breadcrumbPage) {
    return null
  }

  return (
    <Breadcrumb className={cn("flex h-[36px] w-full items-center", props.className)}>
      <BreadcrumbList>
        {breadcrumbs.length >= 2 ? (
          <Fragment>
            <BreadcrumbItem className="border-primary">
              <BreadcrumbPage>
                <DropdownMenu>
                  <DropdownMenuTrigger className={cn(focusRing)}>
                    <BreadcrumbLink asChild>
                      <BreadcrumbEllipsis className={"text-background-solid text-xs"} />
                    </BreadcrumbLink>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {breadcrumbs.map((segment, idx) => {
                      const parentSegments = breadcrumbs.slice(0, idx)
                      const parentPath =
                        parentSegments.length > 0 ? `${parentSegments.join("/")}` : ""

                      const href = `${baseUrl}/${parentPath}/${segment}`

                      return (
                        <Fragment key={href}>
                          <DropdownMenuItem asChild>
                            <SuperLink
                              className="text-background-solid text-xs transition-colors"
                              href={href}
                            >
                              {segment}
                            </SuperLink>
                          </DropdownMenuItem>
                        </Fragment>
                      )
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </BreadcrumbPage>
            </BreadcrumbItem>
          </Fragment>
        ) : (
          breadcrumbs.map((segment, idx) => {
            const parentSegments = breadcrumbs.slice(0, idx)
            const parentPath = parentSegments.length > 0 ? `${parentSegments.join("/")}` : ""

            const href = `${baseUrl}/${parentPath}/${segment}`.replace(/\/\//g, "/")

            return (
              <Fragment key={href}>
                {idx > 0 && <BreadcrumbSeparator className="text-background-solid text-xs" />}
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <SuperLink
                      className="text-background-solid text-xs transition-colors"
                      href={href}
                    >
                      {segment}
                    </SuperLink>
                  </BreadcrumbLink>
                </BreadcrumbItem>
              </Fragment>
            )
          })
        )}
        {breadcrumbs.length > 0 && (
          <BreadcrumbSeparator className="text-background-solid text-xs" />
        )}
        <BreadcrumbItem>
          <BreadcrumbPage className="text-background-text text-xs">{breadcrumbPage}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}
