"use client"

import type { Row } from "@tanstack/react-table"
import { useParams, useRouter } from "next/navigation"
import { startTransition, useMemo, useState } from "react"

import type { ApiKey } from "@unprice/db/validators"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import { Ellipsis } from "@unprice/ui/icons"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@unprice/ui/responsive-dialog"

import { useMutation, useQuery } from "@tanstack/react-query"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { cn } from "@unprice/ui/utils"
import { CheckIcon, ChevronDown } from "lucide-react"
import { FilterScroll } from "~/components/filter-scroll"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

const NO_DEFAULT_CUSTOMER = "__none__"

type ApiKeyCustomer = RouterOutputs["customers"]["listByActiveProject"]["customers"][number]

interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

// Data + mutations for a single API-key row. Keeping the tRPC wiring here lets
// the components below stay focused on rendering.
function useApiKeyRowActions(apikey: ApiKey) {
  const router = useRouter()
  const trpc = useTRPC()
  const { workspaceSlug, projectSlug } = useParams<{
    workspaceSlug: string
    projectSlug: string
  }>()

  const { data: customersData } = useQuery(
    trpc.customers.listByActiveProject.queryOptions({
      search: null,
      from: null,
      to: null,
      page: 1,
      page_size: 1_000,
      workspaceSlug,
      projectSlug,
    })
  )
  const customers = customersData?.customers ?? []
  const isCustomersLoading = !customersData

  const refresh = () => router.refresh()
  const revokeApiKeys = useMutation(trpc.apikeys.revoke.mutationOptions({ onSuccess: refresh }))
  const rollApiKey = useMutation(trpc.apikeys.roll.mutationOptions({ onSuccess: refresh }))
  const bindCustomer = useMutation(
    trpc.apikeys.bindCustomer.mutationOptions({ onSuccess: refresh })
  )
  const unbindCustomer = useMutation(
    trpc.apikeys.unbindCustomer.mutationOptions({ onSuccess: refresh })
  )

  function onRevokeKey() {
    startTransition(() => {
      toast.promise(revokeApiKeys.mutateAsync({ ids: [apikey.id], workspaceSlug, projectSlug }), {
        loading: "Revoking key...",
        success: "Key revoked",
      })
    })
  }

  function onRollKey() {
    startTransition(() => {
      toast.promise(
        rollApiKey
          .mutateAsync({ hashKey: apikey.hash, workspaceSlug, projectSlug })
          .then((data) => {
            navigator.clipboard.writeText(data.apikey.key)
          }),
        {
          loading: "Rolling key...",
          success: "Key rolled. The new key was copied to your clipboard.",
        }
      )
    })
  }

  function saveCustomerBinding(selectedCustomerId: string, onDone: () => void) {
    const nextCustomerId = selectedCustomerId === NO_DEFAULT_CUSTOMER ? null : selectedCustomerId

    if (nextCustomerId === apikey.defaultCustomerId) {
      onDone()
      return
    }

    startTransition(() => {
      if (!nextCustomerId) {
        toast.promise(
          unbindCustomer
            .mutateAsync({ apikeyId: apikey.id, workspaceSlug, projectSlug })
            .then(onDone),
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
            workspaceSlug,
            projectSlug,
          })
          .then(onDone),
        {
          loading: "Saving default customer...",
          success: "Default customer updated",
        }
      )
    })
  }

  return {
    customers,
    isCustomersLoading,
    onRevokeKey,
    onRollKey,
    saveCustomerBinding,
    isSavingCustomerConfig: bindCustomer.isPending || unbindCustomer.isPending,
  }
}

function RowActionsMenu({
  isOpen,
  onOpenChange,
  onConfigureCustomer,
  onRevokeKey,
  onRollKey,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onConfigureCustomer: () => void
  onRevokeKey: () => void
  onRollKey: () => void
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange} open={isOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8">
          <Ellipsis className="size-4" aria-hidden="true" />
          <span className="sr-only">Open row actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault()
            onConfigureCustomer()
          }}
        >
          Configure default customer
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault()
            onRevokeKey()
            onOpenChange(false)
          }}
          className="text-destructive"
        >
          Revoke Key
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault()
            onRollKey()
            onOpenChange(false)
          }}
          className="text-destructive"
        >
          Roll Key
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DefaultCustomerDialogContent({
  customers,
  isCustomersLoading,
  selectedCustomerId,
  selectedCustomer,
  onSelectCustomer,
  switcherOpen,
  onSwitcherOpenChange,
  isSaving,
  onSave,
  onCancel,
}: {
  customers: ApiKeyCustomer[]
  isCustomersLoading: boolean
  selectedCustomerId: string
  selectedCustomer: ApiKeyCustomer | undefined
  onSelectCustomer: (id: string) => void
  switcherOpen: boolean
  onSwitcherOpenChange: (open: boolean) => void
  isSaving: boolean
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <ResponsiveDialogContent>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Default customer</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          Configure which customer is used when requests with this API key omit `customerId`.
        </ResponsiveDialogDescription>
      </ResponsiveDialogHeader>

      <Popover modal={true} open={switcherOpen} onOpenChange={onSwitcherOpenChange}>
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
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
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
                        onSelectCustomer(NO_DEFAULT_CUSTOMER)
                        onSwitcherOpenChange(false)
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
                          onSelectCustomer(selectedCustomerId)
                          onSwitcherOpenChange(false)
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
                          onSelectCustomer(customer.id)
                          onSwitcherOpenChange(false)
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

      <ResponsiveDialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onSave} disabled={isSaving} type="button">
          Save {isSaving && <LoadingAnimation className="ml-2" />}
        </Button>
      </ResponsiveDialogFooter>
    </ResponsiveDialogContent>
  )
}

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const apikey = selectApiKeySchema.parse(row.original)
  const [isOpen, setIsOpen] = useState(false)
  const [customerConfigOpen, setCustomerConfigOpen] = useState(false)
  const [switcherCustomerOpen, setSwitcherCustomerOpen] = useState(false)
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(
    apikey.defaultCustomerId ?? NO_DEFAULT_CUSTOMER
  )

  const {
    customers,
    isCustomersLoading,
    onRevokeKey,
    onRollKey,
    saveCustomerBinding,
    isSavingCustomerConfig,
  } = useApiKeyRowActions(apikey)

  const selectedCustomer = useMemo(
    () => customers.find((customer) => customer.id === selectedCustomerId),
    [customers, selectedCustomerId]
  )

  return (
    <ResponsiveDialog
      open={customerConfigOpen}
      onOpenChange={(open) => {
        setCustomerConfigOpen(open)
        if (open) {
          setSelectedCustomerId(apikey.defaultCustomerId ?? NO_DEFAULT_CUSTOMER)
          setSwitcherCustomerOpen(false)
        }
      }}
    >
      <RowActionsMenu
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        onConfigureCustomer={() => {
          setCustomerConfigOpen(true)
          setIsOpen(false)
        }}
        onRevokeKey={onRevokeKey}
        onRollKey={onRollKey}
      />

      <DefaultCustomerDialogContent
        customers={customers}
        isCustomersLoading={isCustomersLoading}
        selectedCustomerId={selectedCustomerId}
        selectedCustomer={selectedCustomer}
        onSelectCustomer={setSelectedCustomerId}
        switcherOpen={switcherCustomerOpen}
        onSwitcherOpenChange={setSwitcherCustomerOpen}
        isSaving={isSavingCustomerConfig}
        onSave={() => saveCustomerBinding(selectedCustomerId, () => setCustomerConfigOpen(false))}
        onCancel={() => setCustomerConfigOpen(false)}
      />
    </ResponsiveDialog>
  )
}
