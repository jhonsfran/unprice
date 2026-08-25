"use client"

import type { Row } from "@tanstack/react-table"
import { MoreHorizontal } from "lucide-react"
import { useRouter } from "next/navigation"
import * as React from "react"

import { invitesSelectBase } from "@unprice/db/validators"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@unprice/ui/alert-dialog"
import { Button } from "@unprice/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"

import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@unprice/ui/responsive-dialog"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"

import { ROLES_APP } from "@unprice/db/utils"
import { LoadingAnimation } from "@unprice/ui/loading-animation"

import type { WorkspaceRole } from "@unprice/db/validators"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

// TODO: improve this - use as reference the domain-dialog.tsx
export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const invite = invitesSelectBase.parse(row.original)
  const [alertOpen, setAlertOpen] = React.useState(false)
  const [open, setIsOpen] = React.useState(false)
  const [isPending, startTransition] = React.useTransition()
  const [selectedRole, setSelectedRole] = React.useState<WorkspaceRole>(invite.role)
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()

  const changeRoleInvite = useMutation(
    trpc.workspaces.changeRoleInvite.mutationOptions({
      onSettled: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.workspaces.listInvitesByActiveWorkspace.queryKey(),
        })
        router.refresh()
      },
      onSuccess: () => {
        toastAction("success", "Role changed")
        setIsOpen(false)
      },
    })
  )

  const deleteInvite = useMutation(
    trpc.workspaces.deleteInvite.mutationOptions({
      onSettled: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.workspaces.listInvitesByActiveWorkspace.queryKey(),
        })
        router.refresh()
      },
      onSuccess: () => {
        toastAction("deleted")
        setAlertOpen(false)
      },
    })
  )

  const resendInvite = useMutation(
    trpc.workspaces.resendInvite.mutationOptions({
      onSettled: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.workspaces.listInvitesByActiveWorkspace.queryKey(),
        })
        router.refresh()
      },
      onSuccess: () => {
        toastAction("success", "Invite resent")
        setIsOpen(false)
        setAlertOpen(false)
      },
    })
  )

  function onDelete() {
    startTransition(async () => {
      await deleteInvite.mutateAsync({
        email: invite.email,
      })
    })
  }

  function onResend() {
    startTransition(async () => {
      await resendInvite.mutateAsync({
        email: invite.email,
      })
    })
  }

  function onChangeRole() {
    startTransition(async () => {
      await changeRoleInvite.mutateAsync({
        role: selectedRole,
        email: invite.email,
      })
    })
  }

  return (
    <AlertDialog open={alertOpen} onOpenChange={(value) => setAlertOpen(value)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-8 w-8 p-0 data-[state=open]:bg-accent">
            <span className="sr-only">Open menu</span>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setAlertOpen(false)
              setIsOpen(true)
            }}
          >
            Change role
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onResend} disabled={resendInvite.isPending}>
            Resend invite {resendInvite.isPending && <LoadingAnimation />}
          </DropdownMenuItem>
          <AlertDialogTrigger asChild>
            <DropdownMenuItem
              disabled={deleteInvite.isPending}
              className="text-destructive focus:bg-destructive focus:text-background"
            >
              Delete invite from workspace {deleteInvite.isPending && <LoadingAnimation />}
            </DropdownMenuItem>
          </AlertDialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>

      <ResponsiveDialog open={open} onOpenChange={setIsOpen}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Change role</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Select a new role for this user
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <Select
            onValueChange={(data: WorkspaceRole) => {
              setSelectedRole(data)
            }}
            defaultValue={selectedRole}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a new role for this user" />
            </SelectTrigger>
            <SelectContent>
              {ROLES_APP.map((role) => {
                return (
                  <SelectItem key={role} value={role}>
                    {role}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <ResponsiveDialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setIsOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={(e) => {
                e.preventDefault()
                onChangeRole()
              }}
              disabled={changeRoleInvite.isPending}
            >
              Change role {changeRoleInvite.isPending && <LoadingAnimation />}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will remove the user from your team.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              onDelete()
            }}
            disabled={isPending}
          >
            {!isPending ? "Remove" : <LoadingAnimation />}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
