import { Avatar, AvatarFallback } from "@unprice/ui/avatar"
import { Button } from "@unprice/ui/button"
import { Skeleton } from "@unprice/ui/skeleton"

export function WorkspaceSwitcherSkeleton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Select a workspace"
      aria-busy="true"
      className="w-44 justify-between"
    >
      <Avatar className="mr-2 h-5 w-5">
        <AvatarFallback>
          <Skeleton className="aspect-square h-full w-full bg-background-bgHover" />
        </AvatarFallback>
      </Avatar>
      <Skeleton className="h-[20px] w-full bg-background-bgHover" />
      <Skeleton className="ml-2 h-4 w-4 shrink-0 bg-background-bgHover" />
    </Button>
  )
}
