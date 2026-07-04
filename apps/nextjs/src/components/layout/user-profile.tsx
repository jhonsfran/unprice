import type { Session } from "@unprice/auth/server"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import { CreditCard, LogOut, Settings, User } from "@unprice/ui/icons"

import { AUTH_ROUTES } from "@unprice/config"
import { ExternalLink } from "lucide-react"
import { SuperLink } from "../super-link"
import { ThemeToggleItems } from "./theme-toggle"

export default function UserProfile({
  children,
  align = "end",
  session,
}: {
  children: React.ReactNode
  align?: "center" | "start" | "end"
  session: Session
}) {
  if (!session?.user) {
    return null
  }

  const personalWorkspace = session.user.workspaces.find((wk) => wk.isPersonal)
  const user = session.user

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>

      <DropdownMenuContent
        className="max-h-[--radix-dropdown-menu-content-available-height] w-[--radix-dropdown-menu-content-width] min-w-60 max-w-60"
        align={align}
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="truncate font-medium text-sm leading-none">{user.name ?? user.email}</p>
            <p className="truncate text-muted-foreground text-xs leading-none">{user.email}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <ThemeToggleItems />
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <SuperLink href={`/${personalWorkspace?.slug}/settings`}>
              <User className="mr-2 h-4 w-4" />
              <span>Profile</span>
              <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
            </SuperLink>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <SuperLink href={`/${personalWorkspace?.slug}/billing`}>
              <CreditCard className="mr-2 h-4 w-4" />
              <span>Billing</span>
              <DropdownMenuShortcut>⌘B</DropdownMenuShortcut>
            </SuperLink>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <SuperLink href={`/${personalWorkspace?.slug}/settings`}>
              <Settings className="mr-2 h-4 w-4" />
              <span>Settings</span>
              <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
            </SuperLink>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            Changelog
            <ExternalLink className="mb-1 ml-1 size-2.5 shrink-0" aria-hidden="true" />
          </DropdownMenuItem>
          <DropdownMenuItem>
            Documentation
            <ExternalLink className="mb-1 ml-1 size-2.5 shrink-0" aria-hidden="true" />
          </DropdownMenuItem>
          <DropdownMenuItem>
            Join Discord community
            <ExternalLink className="mb-1 ml-1 size-2.5 shrink-0" aria-hidden="true" />
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <SuperLink href={`${AUTH_ROUTES.SIGNOUT}`}>
            <LogOut className="mr-2 h-4 w-4" />
            <span>Log out</span>
            <DropdownMenuShortcut>⇧⌘Q</DropdownMenuShortcut>
          </SuperLink>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
