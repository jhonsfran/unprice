"use client"
import { useState } from "react"

import { Button } from "@unprice/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@unprice/ui/responsive-dialog"
import CreateApiKeyForm from "./create-api-key-form"

export default function NewApiKeyDialog() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [createdKey, setCreatedKey] = useState(false)

  return (
    <ResponsiveDialog
      open={dialogOpen}
      onOpenChange={(open) => {
        setDialogOpen(open)
        if (!open) {
          setCreatedKey(false)
        }
      }}
    >
      <ResponsiveDialogTrigger asChild>
        <Button>Create API key</Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {createdKey ? "API key created" : "Create API key"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {createdKey
              ? "Copy the secret now. You will not be able to view it again after closing this dialog."
              : "Create a key for project API access."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <CreateApiKeyForm
          setDialogOpen={setDialogOpen}
          onSuccess={(value) => setCreatedKey(Boolean(value))}
          defaultValues={{
            name: "",
            expiresAt: null,
            defaultCustomerId: null,
          }}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
