"use client"

import { Button } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"
import { useRouter } from "next/navigation"
import { useEffect } from "react"
import { logError } from "~/actions/log-error"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { fontMapper } from "~/styles/fonts"

export default function GlobalError({
  reset,
  error,
}: {
  error: Error
  reset: () => void
}) {
  const router = useRouter()

  useEffect(() => {
    void logError(error)
  }, [error])

  const description = error.message
    ? `Refresh this view or go back. Details: ${error.message}`
    : "Refresh this view or go back. The dashboard state could not be recovered."

  return (
    <html lang="en">
      <body
        className={cn(
          "antialiased",
          fontMapper["font-primary"],
          fontMapper["font-secondary"],
          fontMapper["font-mono"]
        )}
      >
        <DashboardShell>
          <div className="flex flex-col items-center justify-center">
            <EmptyPlaceholder className="min-h-[520px] w-full">
              <EmptyPlaceholder.Title className="mt-0" variant="h1">
                Dashboard could not load
              </EmptyPlaceholder.Title>
              <EmptyPlaceholder.Description className="mx-auto max-w-xl text-center">
                {description}
              </EmptyPlaceholder.Description>
              <EmptyPlaceholder.Action>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                  <Button variant="primary" onClick={() => reset()}>
                    Try again
                  </Button>
                  <Button variant="default" onClick={() => router.back()}>
                    Go back
                  </Button>
                </div>
              </EmptyPlaceholder.Action>
            </EmptyPlaceholder>
          </div>
        </DashboardShell>
      </body>
    </html>
  )
}
