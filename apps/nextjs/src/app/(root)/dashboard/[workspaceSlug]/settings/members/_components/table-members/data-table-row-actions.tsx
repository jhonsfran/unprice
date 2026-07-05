"use client"

import type { Row } from "@tanstack/react-table"
import { MoreHorizontal } from "lucide-react"
import { useRouter } from "next/navigation"
import * as React from "react"

import { ROLES_APP } from "@unprice/db/utils"
import type { WorkspaceRole } from "@unprice/db/validators"
import { listMembersSchema } from "@unprice/db/validators"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@unprice/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const member = listMembersSchema.parse(row.original)
  const [open, setIsOpen] = React.useState(false)
  const [selectedRole, setSelectedRole] = React.useState<WorkspaceRole>(member.role)
  const [alertOpen, setAlertOpen] = React.useState(false)
  const [isPending, startTransition] = React.useTransition()

  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()

  const deleteMember = useMutation(
    trpc.workspaces.deleteMember.mutationOptions({
      onSettled: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.workspaces.listMembersByActiveWorkspace.queryKey(),
        })
        router.refresh()
      },
      onSuccess: () => {
        toastAction("deleted")
      },
    })
  )

  const changeRoleMember = useMutation(
    trpc.workspaces.changeRoleMember.mutationOptions({
      onSettled: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.workspaces.listMembersByActiveWorkspace.queryKey(),
        })
        router.refresh()
      },
      onSuccess: () => {
        toastAction("success")
        setIsOpen(false)
      },
    })
  )

  function onChangeRole() {
    startTransition(async () => {
      setIsOpen(false)

      await changeRoleMember.mutateAsync({
        userId: member.userId,
        role: selectedRole,
      })
    })
  }

  function onDelete() {
    startTransition(async () => {
      await deleteMember.mutateAsync({
        userId: member.userId,
        workspaceId: member.workspaceId,
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
              setIsOpen(true)
              setAlertOpen(false)
            }}
          >
            Change role
          </DropdownMenuItem>
          <AlertDialogTrigger asChild>
            <DropdownMenuItem className="text-danger-text focus:bg-danger-solid focus:text-danger-foreground">
              Delete member from workspace
            </DropdownMenuItem>
          </AlertDialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setIsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change role</DialogTitle>
            <DialogDescription>Select a new role for this user</DialogDescription>
          </DialogHeader>
          <Select
            onValueChange={(data: WorkspaceRole) => {
              setSelectedRole(data)
            }}
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
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setIsOpen(false)
              }}
            >
              Close
            </Button>
            <Button
              onClick={(e) => {
                e.preventDefault()
                onChangeRole()
              }}
              disabled={changeRoleMember.isPending}
            >
              Change role {changeRoleMember.isPending && <LoadingAnimation className="ml-2" />}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
            Remove {isPending && <LoadingAnimation className="ml-2" />}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
