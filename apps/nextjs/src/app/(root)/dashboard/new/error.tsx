"use client"

import { EmptyPlaceholder } from "~/components/empty-placeholder"

import { Button } from "@unprice/ui/button"
import { ShieldAlert } from "lucide-react"
import { useEffect } from "react"
import { logError } from "~/actions/log-error"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { SuperLink } from "~/components/super-link"

export default function ErrorOnboarding({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    void logError(error)
  }, [error])

  return (
    <DashboardShell>
      <div className="flex flex-col items-center justify-center">
        <EmptyPlaceholder>
          <EmptyPlaceholder.Icon>
            <ShieldAlert className="size-10" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>Something went wrong</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>{error.message}</EmptyPlaceholder.Description>
          <EmptyPlaceholder.Action>
            <SuperLink href="/">
              <Button variant="primary" onClick={() => reset()}>
                Dashboard
              </Button>
            </SuperLink>
          </EmptyPlaceholder.Action>
        </EmptyPlaceholder>
      </div>
    </DashboardShell>
  )
}
