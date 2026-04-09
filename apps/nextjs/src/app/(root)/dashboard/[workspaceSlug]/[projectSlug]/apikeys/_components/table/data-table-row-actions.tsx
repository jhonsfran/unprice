"use client"

import type { Row } from "@tanstack/react-table"
import { useRouter } from "next/navigation"
import { startTransition, useMemo, useState } from "react"

import { selectApiKeySchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
} from "@unprice/ui/command"
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
import { Ellipsis } from "@unprice/ui/icons"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"

import { useMutation, useQuery } from "@tanstack/react-query"
import { cn } from "@unprice/ui/utils"
import { CheckIcon, ChevronDown } from "lucide-react"
import { FilterScroll } from "~/components/filter-scroll"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

const NO_DEFAULT_CUSTOMER = "__none__"

interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const apikey = selectApiKeySchema.parse(row.original)
  const [isOpen, setIsOpen] = useState(false)
  const [customerConfigOpen, setCustomerConfigOpen] = useState(false)
  const [switcherCustomerOpen, setSwitcherCustomerOpen] = useState(false)
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(
    apikey.defaultCustomerId ?? NO_DEFAULT_CUSTOMER
  )
  const router = useRouter()
  const trpc = useTRPC()
  const { data: customersData } = useQuery(
    trpc.customers.listByActiveProject.queryOptions({
      search: null,
      from: null,
      to: null,
      page: 1,
      page_size: 1_000,
    })
  )
  const customers = customersData?.customers ?? []
  const isCustomersLoading = !customersData

  const selectedCustomer = useMemo(
    () => customers.find((customer) => customer.id === selectedCustomerId),
    [customers, selectedCustomerId]
  )

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

  const bindCustomer = useMutation(
    trpc.apikeys.bindCustomer.mutationOptions({
      onSuccess: () => {
        router.refresh()
      },
    })
  )

  const unbindCustomer = useMutation(
    trpc.apikeys.unbindCustomer.mutationOptions({
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

  function onSaveCustomerBinding() {
    const nextCustomerId = selectedCustomerId === NO_DEFAULT_CUSTOMER ? null : selectedCustomerId

    if (nextCustomerId === apikey.defaultCustomerId) {
      setCustomerConfigOpen(false)
      return
    }

    startTransition(() => {
      if (!nextCustomerId) {
        toast.promise(
          unbindCustomer
            .mutateAsync({
              apikeyId: apikey.id,
            })
            .then(() => {
              setCustomerConfigOpen(false)
            }),
          {
            loading: "Removing default customer...",
            success: "Default customer removed",
          }
        )
        return
      }

      toast.promise(
        bindCustomer
          .mutateAsync({
            apikeyId: apikey.id,
            customerId: nextCustomerId,
          })
          .then(() => {
            setCustomerConfigOpen(false)
          }),
        {
          loading: "Saving default customer...",
          success: "Default customer updated",
        }
      )
    })
  }

  const isSavingCustomerConfig = bindCustomer.isPending || unbindCustomer.isPending

  return (
    <Dialog
      open={customerConfigOpen}
      onOpenChange={(open) => {
        setCustomerConfigOpen(open)
        if (open) {
          setSelectedCustomerId(apikey.defaultCustomerId ?? NO_DEFAULT_CUSTOMER)
          setSwitcherCustomerOpen(false)
        }
      }}
    >
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
              setCustomerConfigOpen(true)
              setIsOpen(false)
            }}
          >
            Configure default customer
          </DropdownMenuItem>

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

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Default customer</DialogTitle>
          <DialogDescription>
            Configure which customer is used when requests with this API key omit `customerId`.
          </DialogDescription>
        </DialogHeader>

        <Popover modal={true} open={switcherCustomerOpen} onOpenChange={setSwitcherCustomerOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" className={cn("w-full justify-between")}>
              {isCustomersLoading ? (
                <LoadingAnimation className="h-4 w-4" variant="dots" />
              ) : selectedCustomer ? (
                `${selectedCustomer.email} - ${selectedCustomer.name}`
              ) : selectedCustomerId !== NO_DEFAULT_CUSTOMER ? (
                selectedCustomerId
              ) : (
                "No default customer"
              )}
              <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="max-h-[--radix-popover-content-available-height] w-[--radix-popover-trigger-width] p-0">
            <Command>
              <CommandInput placeholder="Search customer..." />
              <CommandList className="overflow-hidden">
                <CommandEmpty>No customer found.</CommandEmpty>
                <FilterScroll>
                  <CommandGroup>
                    {isCustomersLoading && <CommandLoading>Loading...</CommandLoading>}
                    <div className="flex flex-col gap-2 pt-1">
                      <CommandItem
                        value="No default customer"
                        onSelect={() => {
                          setSelectedCustomerId(NO_DEFAULT_CUSTOMER)
                          setSwitcherCustomerOpen(false)
                        }}
                      >
                        <CheckIcon
                          className={cn(
                            "mr-2 h-4 w-4",
                            selectedCustomerId === NO_DEFAULT_CUSTOMER ? "opacity-100" : "opacity-0"
                          )}
                        />
                        No default customer
                      </CommandItem>
                      {selectedCustomerId !== NO_DEFAULT_CUSTOMER && !selectedCustomer && (
                        <CommandItem
                          value={selectedCustomerId}
                          onSelect={() => {
                            setSelectedCustomerId(selectedCustomerId)
                            setSwitcherCustomerOpen(false)
                          }}
                        >
                          <CheckIcon className="mr-2 h-4 w-4 opacity-100" />
                          {selectedCustomerId}
                        </CommandItem>
                      )}
                      {customers.map((customer) => (
                        <CommandItem
                          value={`${customer.email} ${customer.name} ${customer.id}`}
                          key={customer.id}
                          onSelect={() => {
                            setSelectedCustomerId(customer.id)
                            setSwitcherCustomerOpen(false)
                          }}
                        >
                          <CheckIcon
                            className={cn(
                              "mr-2 h-4 w-4",
                              customer.id === selectedCustomerId ? "opacity-100" : "opacity-0"
                            )}
                          />
                          {`${customer.email} - ${customer.name}`}
                        </CommandItem>
                      ))}
                    </div>
                  </CommandGroup>
                </FilterScroll>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {selectedCustomer && (
          <p className="text-muted-foreground text-sm">
            Selected: {selectedCustomer.email} ({selectedCustomer.id})
          </p>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setCustomerConfigOpen(false)
            }}
          >
            Cancel
          </Button>
          <Button onClick={onSaveCustomerBinding} disabled={isSavingCustomerConfig} type="button">
            Save {isSavingCustomerConfig && <LoadingAnimation className="ml-2" />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
