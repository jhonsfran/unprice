import type { RouterOutputs } from "@unprice/trpc/routes"
import { Card, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { SuperLink } from "~/components/super-link"

// Ledger-native cover: dot-grid paper with the project monogram. Replaces the
// generated pattern covers, which fought the sand/amber palette.
function ProjectCover({ name }: { name: string }) {
  const monogram = name
    .split(/\s+/)
    .map((word) => word.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase()

  return (
    <div className="ledger-dots relative flex h-32 items-end overflow-hidden border-b bg-background-bgSubtle px-4 pb-3">
      <span className="select-none font-mono font-semibold text-4xl text-background-solid">
        {monogram}
      </span>
    </div>
  )
}

function InternalProjectIndicator() {
  return (
    <span className="danger ml-2 whitespace-nowrap rounded-md px-2 py-1 font-mono text-xs no-underline group-hover:no-underline">
      INTERNAL
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
        <ProjectCover name={project.name} />
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="whitespace-nowrap">{project.name}</span>
            {/* the workspace plan chip lives in the header switcher; the card
                only flags project-specific state */}
            {project.isInternal && <InternalProjectIndicator />}
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
        </CardTitle>
        <CardDescription className={cn("bg-muted", pulse && "animate-pulse")}>
          &nbsp;
        </CardDescription>
      </CardHeader>
    </Card>
  )
}
