"use client"
import { useState } from "react"

import { Button } from "@unprice/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"
import { Add } from "@unprice/ui/icons"
import CreateApiKeyForm from "./create-api-key-form"

export default function NewApiKeyDialog() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [createdKey, setCreatedKey] = useState(false)

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => {
        setDialogOpen(open)
        if (!open) {
          setCreatedKey(false)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Add className="mr-2 size-4" aria-hidden="true" />
          Create API key
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{createdKey ? "API key created" : "Create API key"}</DialogTitle>
          <DialogDescription>
            {createdKey
              ? "Copy the secret now. You will not be able to view it again after closing this dialog."
              : "Create a key for project API access."}
          </DialogDescription>
        </DialogHeader>
        <CreateApiKeyForm
          setDialogOpen={setDialogOpen}
          onSuccess={(value) => setCreatedKey(Boolean(value))}
          defaultValues={{
            name: "",
            expiresAt: null,
            defaultCustomerId: null,
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
