"use client"

import { Button } from "@unprice/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@unprice/ui/responsive-dialog"
import { useState } from "react"

import { InviteMemberForm } from "./invite-member-form"

export const InviteMemberDialog = () => {
  const [open, setOpen] = useState(false)

  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      <ResponsiveDialogTrigger asChild>
        <Button>Invite member</Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Invite to Workspace</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Invite a member to this workspace
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <InviteMemberForm onSuccess={() => setOpen(false)} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
