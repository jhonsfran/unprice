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

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button>
          <Add className="mr-2 h-4 w-4" />
          API Key
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API Key</DialogTitle>
          <DialogDescription>Fill out the form to create an API key.</DialogDescription>
        </DialogHeader>
        <CreateApiKeyForm
          setDialogOpen={setDialogOpen}
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
