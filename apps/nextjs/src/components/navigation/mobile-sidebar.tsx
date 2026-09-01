import { Button } from "@unprice/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@unprice/ui/drawer"
import { MoreVertical } from "lucide-react"

export default function MobileSidebar({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <Drawer>
      <DrawerTrigger asChild>
        <Button
          variant="ghost"
          aria-label="Open navigation menu"
          className="group flex items-center rounded-md p-2 font-medium text-sm"
        >
          <MoreVertical className="size-4 shrink-0" aria-hidden="true" />
        </Button>
      </DrawerTrigger>
      <DrawerContent className="!h-[calc(100dvh-0.5rem)] !max-h-[calc(100dvh-0.5rem)] w-full gap-0 overflow-hidden p-0">
        <div className="flex min-h-0 flex-1 flex-col px-4">
          <DrawerHeader className="shrink-0 px-0 py-4">
            <DrawerTitle>Menu</DrawerTitle>
            <DrawerDescription>
              <span className="text-muted-foreground">Quick access to project navigation</span>
            </DrawerDescription>
          </DrawerHeader>
          <div className="hide-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-[max(5rem,env(safe-area-inset-bottom))]">
            {children}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
