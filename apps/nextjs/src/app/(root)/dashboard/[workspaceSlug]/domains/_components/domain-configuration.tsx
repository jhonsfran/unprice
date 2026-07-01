import { use } from "react"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Skeleton } from "@unprice/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unprice/ui/tabs"
import { cn } from "@unprice/ui/utils"

import { getSubdomain } from "~/lib/domains"
import DomainStatusIcon from "./domain-status-icon"

export const InlineSnippet = ({
  className,
  children,
}: {
  className?: string
  children?: string
}) => {
  return (
    <span className={cn("inline-block rounded-md bg-muted px-1 py-0.5 font-mono", className)}>
      {children}
    </span>
  )
}

export default function DomainConfiguration({
  domainPromise,
}: {
  domainPromise: Promise<RouterOutputs["domains"]["verify"]>
}) {
  const { status, domainProvider } = use(domainPromise)

  if (!status || !domainProvider) return null

  const subdomain =
    domainProvider?.name && domainProvider?.apexName
      ? getSubdomain(domainProvider.name, domainProvider.apexName)
      : null

  const txtVerification =
    (status === "Pending Verification" &&
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      domainProvider?.verification?.find((x: any) => x.type === "TXT")) ??
    null

  return (
    <div>
      <div className="mb-4 flex items-center space-x-2">
        <DomainStatusIcon status={status} />
        <p className="font-semibold text-lg">{status}</p>
      </div>
      {txtVerification ? (
        <>
          <p className="text-sm">
            Please set the following TXT record on{" "}
            <InlineSnippet>{domainProvider.apexName}</InlineSnippet> to prove ownership of{" "}
            <InlineSnippet>{domainProvider.name}</InlineSnippet>:
          </p>
          <div className="my-5 flex items-start justify-start space-x-10 rounded-md bg-muted p-2">
            <div>
              <p className="font-bold text-sm">Type</p>
              <p className="mt-2 font-mono text-sm">{txtVerification.type}</p>
            </div>
            <div>
              <p className="font-bold text-sm">Name</p>
              <p className="mt-2 font-mono text-sm">
                {txtVerification.domain.slice(
                  0,
                  txtVerification.domain.length - (domainProvider?.apexName?.length ?? 0) - 1
                )}
              </p>
            </div>
            <div>
              <p className="font-bold text-sm">Value</p>
              <p className="mt-2 font-mono text-sm">
                <span className="text-ellipsis">{txtVerification.value}</span>
              </p>
            </div>
          </div>
          <p className="font-normal text-muted-foreground text-sm">
            <b>Warning:</b> if you are using this domain for another site, setting this TXT record
            will transfer domain ownership away from that site and break it. Please exercise caution
            when setting this record.
          </p>
        </>
      ) : status === "Unknown Error" ? (
        <p className="mb-5 text-sm">{status}</p>
      ) : (
        <>
          <Tabs defaultValue={subdomain ? "CNAME" : "A"}>
            <TabsList>
              <TabsTrigger value="A">A Record{!subdomain && " (recommended)"}</TabsTrigger>
              <TabsTrigger value="CNAME">CNAME Record{subdomain && " (recommended)"}</TabsTrigger>
            </TabsList>
            <TabsContent value="A">
              <div className="my-3 text-left">
                <p className="my-5 text-sm">
                  To configure your apex domain (
                  <InlineSnippet>{domainProvider.apexName}</InlineSnippet>
                  ), set the following A record on your DNS provider to continue:
                </p>
                <div className="flex items-center justify-start space-x-10 rounded-md bg-muted p-2">
                  <div>
                    <p className="font-bold text-sm">Type</p>
                    <p className="mt-2 font-mono text-sm">A</p>
                  </div>
                  <div>
                    <p className="font-bold text-sm">Name</p>
                    <p className="mt-2 font-mono text-sm">@</p>
                  </div>
                  <div>
                    <p className="font-bold text-sm">Value</p>
                    <p className="mt-2 font-mono text-sm">76.76.21.21</p>
                  </div>
                  <div>
                    <p className="font-bold text-sm">TTL</p>
                    <p className="mt-2 font-mono text-sm">86400</p>
                  </div>
                </div>
              </div>
            </TabsContent>
            <TabsContent value="CNAME">
              <div className="my-3 text-left">
                <p className="my-5 text-sm">
                  To configure your subdomain (<InlineSnippet>{domainProvider.name}</InlineSnippet>
                  ), set the following CNAME record on your DNS provider to continue:
                </p>
                <div className="flex items-center justify-start space-x-10 rounded-md bg-muted p-2">
                  <div>
                    <p className="font-bold text-sm">Type</p>
                    <p className="mt-2 font-mono text-sm">CNAME</p>
                  </div>
                  <div>
                    <p className="font-bold text-sm">Name</p>
                    <p className="mt-2 font-mono text-sm">{subdomain ?? "www"}</p>
                  </div>
                  <div>
                    <p className="font-bold text-sm">Value</p>
                    <p className="mt-2 font-mono text-sm">{"cname.vercel-dns.com"}</p>
                  </div>
                  <div>
                    <p className="font-bold text-sm">TTL</p>
                    <p className="mt-2 font-mono text-sm">86400</p>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
          <p className="muted-foreground mt-5 text-sm">
            Note: for TTL, if <InlineSnippet>86400</InlineSnippet> is not available, set the highest
            value possible. Also, domain propagation can take up to an hour.
          </p>
        </>
      )}
    </div>
  )
}

const DomainConfigSkeleton = () => (
  <div>
    <div className="mb-4 flex items-center space-x-2">
      <Skeleton className="h-6 w-[200px]" />
    </div>
    <div className="my-3 flex flex-col space-y-4 text-left">
      <Skeleton className="h-6 w-[250px]" />
      <div className="my-5 text-sm">
        <Skeleton className="h-4 w-full" />
      </div>
      <Skeleton className="h-[48px] w-full space-x-10 rounded-md bg-muted p-2" />
      <Skeleton className="h-4 w-full" />
    </div>
  </div>
)

DomainConfiguration.Skeleton = DomainConfigSkeleton
