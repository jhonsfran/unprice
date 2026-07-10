import { AlertCircle, Lock } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"

export function BannerPublishedVersion() {
  return (
    <Alert variant="success" className="py-3 [&>svg+div]:translate-y-0 [&>svg]:top-3">
      <Lock className="size-4" />
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2">
        <AlertTitle className="shrink-0">Published version is locked</AlertTitle>
        <AlertDescription className="font-light">
          Pricing and features can’t be edited. Update the description, deactivate it, or duplicate
          this version to make changes.
        </AlertDescription>
      </div>
    </Alert>
  )
}

export function BannerInactiveVersion() {
  return (
    <Alert variant="destructive" className="py-3 [&>svg+div]:translate-y-0 [&>svg]:top-3">
      <AlertCircle className="size-4" />
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2">
        <AlertTitle className="shrink-0">Version Inactive</AlertTitle>
        <AlertDescription className="font-light">
          This version was deactivated and it's not available for new customers. Customers already
          subscribed to this version won't be affected.
        </AlertDescription>
      </div>
    </Alert>
  )
}
