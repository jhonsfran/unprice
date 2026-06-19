import { Button } from "@unprice/ui/button"

import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { SuperLink } from "~/components/super-link"

export default function NotFound() {
  return (
    <EmptyPlaceholder className="mx-4 my-4">
      <EmptyPlaceholder.Title>404 Not Found</EmptyPlaceholder.Title>
      <EmptyPlaceholder.Description>
        We could not find the page that you are looking for!
      </EmptyPlaceholder.Description>
      <div className="flex flex-col items-center justify-center gap-2 md:flex-row">
        <SuperLink href="/">
          <Button variant="secondary" className="w-full items-center gap-2">
            Go Back
          </Button>
        </SuperLink>
      </div>
    </EmptyPlaceholder>
  )
}
