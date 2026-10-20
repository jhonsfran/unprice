import { buttonVariants } from "@unprice/ui/button"
import { SearchX } from "lucide-react"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { SuperLink } from "~/components/super-link"

export function BudgetNotFound({ listHref }: { listHref: string }) {
  return (
    <EmptyPlaceholder className="min-h-[360px]">
      <EmptyPlaceholder.Icon>
        <SearchX className="size-8" />
      </EmptyPlaceholder.Icon>
      <EmptyPlaceholder.Title>Budget not found</EmptyPlaceholder.Title>
      <EmptyPlaceholder.Description>
        This project has no budget with this id. It may have been removed after it closed.
      </EmptyPlaceholder.Description>
      <EmptyPlaceholder.Action>
        <SuperLink href={listHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Back to budgets
        </SuperLink>
      </EmptyPlaceholder.Action>
    </EmptyPlaceholder>
  )
}
