import { isSlug } from "@unprice/db/utils"
import BreadcrumbsApp from "~/components/layout/breadcrumbs"
import { api } from "~/trpc/server"

export default async function Page(props: {
  params: {
    all: string[]
  }
  searchParams: {
    workspaceSlug?: string
    projectSlug?: string
    customerId?: string
  }
}) {
  const all = [...props.params.all]
  const { workspaceSlug, projectSlug, customerId } = props.searchParams

  // delete the first segment, which is always "/app"
  all.shift()

  // pages has another layout
  // if (all.length > 3 && all.includes("pages")) {
  //   return null
  // }

  let baseUrl = "/"

  if (isSlug(workspaceSlug) || isSlug(all.at(0))) {
    const workspaceSegment = workspaceSlug ?? all.at(0)

    baseUrl += `${workspaceSegment}`
    // delete workspace slug from segments
    all.shift()
  }

  if (isSlug(projectSlug) || isSlug(all.at(0))) {
    const projectSegment = projectSlug ?? all.at(0)

    baseUrl += `/${projectSegment}`
    // delete project slug from segments
    all.shift()
  }

  const breadcrumbs = await withCustomerSubscriptionBreadcrumbs(all, customerId)

  return (
    <div className="px-4 md:px-6">
      <BreadcrumbsApp breadcrumbs={breadcrumbs} baseUrl={baseUrl} />
    </div>
  )
}

async function withCustomerSubscriptionBreadcrumbs(
  segments: string[],
  customerIdFromQuery?: string
) {
  if (segments[0] !== "customers" || segments[1] !== "subscriptions") {
    return segments
  }

  const subscriptionSegment = segments[2]

  if (!subscriptionSegment) {
    return segments
  }

  const customerId =
    subscriptionSegment === "new"
      ? customerIdFromQuery
      : await getSubscriptionCustomerId(subscriptionSegment)

  if (!customerId) {
    return segments
  }

  return ["customers", customerId, "subscriptions", ...segments.slice(2)]
}

async function getSubscriptionCustomerId(subscriptionId: string) {
  try {
    const { subscription } = await api.subscriptions.getById({
      id: subscriptionId,
    })

    return subscription.customerId
  } catch {
    return undefined
  }
}
