import type { RouterOutputs } from "@unprice/trpc/routes"
import { Card, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { SuperLink } from "~/components/super-link"

function ProjectTierIndicator(props: { tier: string; isInternal?: boolean }) {
  return (
    <span
      className={cn(
        "ml-2 whitespace-nowrap rounded-md px-2 py-1 font-mono text-xs no-underline group-hover:no-underline",
        {
          danger: props.isInternal,
          "bg-blue-100 dark:bg-blue-800":
            props.tier.toLocaleUpperCase() === "PRO" && !props.isInternal,
          "bg-red-100 dark:bg-red-800":
            props.tier.toLocaleUpperCase() === "ENTERPRISE" && !props.isInternal,
          "bg-teal-100 dark:bg-teal-600":
            props.tier.toLocaleUpperCase() === "FREE" && !props.isInternal,
        }
      )}
    >
      {`${props.tier.length > 4 ? `${props.tier.slice(0, 4)}.` : props.tier}`}{" "}
      {props.isInternal && " - INTER."}
    </span>
  )
}

export function ProjectCard(props: {
  workspaceSlug: string
  project: RouterOutputs["projects"]["listByWorkspace"]["projects"][number]
}) {
  const { project } = props
  return (
    <SuperLink href={`/${props.workspaceSlug}/${project.slug}/dashboard`}>
      <Card className="overflow-hidden">
        <div className="h-32" style={project.styles} />
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="whitespace-nowrap">{project.name}</span>
            <ProjectTierIndicator
              tier={project.workspace.currentPlanSlug ?? "free"}
              isInternal={project.isInternal}
            />
          </CardTitle>
          <CardDescription>{project.url}&nbsp;</CardDescription>
        </CardHeader>
      </Card>
    </SuperLink>
  )
}

export function ProjectCardSkeleton(props: { pulse?: boolean }) {
  const { pulse = true } = props
  return (
    <Card>
      <div className={cn("h-32 bg-muted", pulse && "animate-pulse")} />
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className={cn("flex-1 bg-muted", pulse && "animate-pulse")}>&nbsp;</span>
          <ProjectTierIndicator tier="FREE" />
        </CardTitle>
        <CardDescription className={cn("bg-muted", pulse && "animate-pulse")}>
          &nbsp;
        </CardDescription>
      </CardHeader>
    </Card>
  )
}
