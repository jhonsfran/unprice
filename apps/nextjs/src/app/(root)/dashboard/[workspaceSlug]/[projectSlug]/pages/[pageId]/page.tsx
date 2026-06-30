import { SITES_BASE_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Separator } from "@unprice/ui/separator"
import { ExternalLink } from "lucide-react"
import { notFound } from "next/navigation"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import PageBuilderConfig from "~/components/pager/builder"
import { SuperLink } from "~/components/super-link"
import { generatePreviewToken } from "~/lib/preview"
import { api } from "~/trpc/server"
import { PageActions } from "../_components/page-actions"

export default async function PageEditor({
  params: { pageId },
}: {
  params: { workspaceSlug: string; projectSlug: string; pageId: string }
}) {
  const { page } = await api.pages.getById({
    id: pageId,
  })

  if (!page) {
    notFound()
  }

  const isHTTPS = process.env.NODE_ENV === "production"
  const domain = page.customDomain
    ? `${isHTTPS ? "https" : "http"}://${page.customDomain}`
    : `${isHTTPS ? "https" : "http"}://${page.subdomain}.${SITES_BASE_DOMAIN}`

  const previewToken = await generatePreviewToken(page.id)

  return (
    <DashboardShell
      header={
        <HeaderTab
          title={page.name}
          description={page.description}
          label={page.published ? "published" : "draft"}
          id={pageId}
          action={
            <div className="button-primary flex items-center space-x-1 rounded-md">
              <div className="sm:col-span-full">
                <SuperLink href={`${domain}?revalidate=${previewToken}`} target="_blank">
                  <Button variant={"custom"}>
                    <ExternalLink className="mr-2 h-4 w-4" /> Preview
                  </Button>
                </SuperLink>
              </div>

              <Separator orientation="vertical" className="h-[20px] p-0" />

              <PageActions page={page} />
            </div>
          }
        />
      }
    >
      <PageBuilderConfig page={page} />
    </DashboardShell>
  )
}
