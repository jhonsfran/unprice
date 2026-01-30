"use client"

import type { Row } from "@tanstack/react-table"
import { useRouter } from "next/navigation"
import { startTransition, useState } from "react"

import { selectApiKeySchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import { Ellipsis } from "@unprice/ui/icons"

import { useMutation } from "@tanstack/react-query"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const apikey = selectApiKeySchema.parse(row.original)
  const [isOpen, setIsOpen] = useState(false)
  const router = useRouter()
  const trpc = useTRPC()

  const revokeApiKeys = useMutation(
    trpc.apikeys.revoke.mutationOptions({
      onSuccess: () => {
        router.refresh()
      },
    })
  )

  const rollApiKey = useMutation(
    trpc.apikeys.roll.mutationOptions({
      onSuccess: () => {
        router.refresh()
      },
    })
  )

  function onRevokeKey() {
    startTransition(() => {
      toast.promise(
        revokeApiKeys.mutateAsync({
          ids: [apikey.id],
        }),
        {
          loading: "Revoking key...",
          success: "Key revoked",
        }
      )
    })
  }

  function onRollKey() {
    startTransition(() => {
      toast.promise(
        rollApiKey
          .mutateAsync({
            hashKey: apikey.hash,
          })
          .then((data) => {
            navigator.clipboard.writeText(data.apikey.key)
          }),
        {
          loading: "Rolling key...",
          success: "Key rolled, your new key is been copied to your clipboard",
        }
      )
    })
  }

  return (
    <DropdownMenu onOpenChange={setIsOpen} open={isOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 w-8 p-0">
          <span className="sr-only">Open menu</span>
          <Ellipsis className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault()
            onRevokeKey()
            setIsOpen(false)
          }}
          className="text-destructive"
        >
          Revoke Key
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault()
            onRollKey()
            setIsOpen(false)
          }}
          className="text-destructive"
        >
          Roll Key
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
