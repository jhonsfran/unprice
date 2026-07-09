"use client"

import { Button } from "@unprice/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"
import { useState } from "react"

import { InviteMemberForm } from "./invite-member-form"

export const InviteMemberDialog = () => {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Invite member</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite to Workspace</DialogTitle>
          <DialogDescription>Invite a member to this workspace</DialogDescription>
        </DialogHeader>
        <InviteMemberForm onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}
