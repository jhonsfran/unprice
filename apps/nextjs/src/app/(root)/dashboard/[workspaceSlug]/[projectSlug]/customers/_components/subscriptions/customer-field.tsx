"use client"
import type { UseFormReturn } from "react-hook-form"

import { useQuery } from "@tanstack/react-query"
import type { InsertSubscription } from "@unprice/db/validators"
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
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@unprice/ui/form"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { cn } from "@unprice/ui/utils"
import { CheckIcon, ChevronDown } from "lucide-react"
import { useState } from "react"
import { CopyButton } from "~/components/copy-button"
import { FilterScroll } from "~/components/filter-scroll"
import { useTRPC } from "~/trpc/client"

export default function CustomerFormField({
  form,
  isDisabled,
}: {
  form: UseFormReturn<InsertSubscription>
  isDisabled?: boolean
}) {
  const trpc = useTRPC()
  const [switcherCustomerOpen, setSwitcherCustomerOpen] = useState(false)
  const customerId = form.watch("customerId")

  // customer lists
  const { data: customers, isLoading } = useQuery(
    trpc.customers.listByActiveProject.queryOptions({
      search: null,
      from: null,
      to: null,
      page: 1,
      page_size: 100,
    })
  )

  const selectedCustomer = customers?.customers.find((customer) => customer.id === customerId)

  return (
    <FormField
      control={form.control}
      name="customerId"
      render={({ field }) => (
        <FormItem className="flex flex-col">
          <FormLabel>
            Customer{" "}
            {selectedCustomer && (
              <CopyButton value={selectedCustomer.id ?? ""} className="size-3" />
            )}
          </FormLabel>
          <FormDescription>
            {isDisabled
              ? "The customer on an existing subscription cannot be changed"
              : "Select the customer for this subscription"}
          </FormDescription>
          <Popover
            modal={true}
            open={switcherCustomerOpen}
            onOpenChange={() => {
              if (isDisabled) return
              setSwitcherCustomerOpen(!switcherCustomerOpen)
            }}
          >
            <PopoverTrigger asChild>
              <div className="">
                <FormControl>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isDisabled}
                    className={cn("w-full justify-between")}
                  >
                    {isLoading ? (
                      <LoadingAnimation className="h-4 w-4" variant="dots" />
                    ) : selectedCustomer ? (
                      `${selectedCustomer.email} - ${selectedCustomer.name}`
                    ) : (
                      "Select customer"
                    )}
                    <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </FormControl>
              </div>
            </PopoverTrigger>
            <PopoverContent className="max-h-[--radix-popover-content-available-height] w-[--radix-popover-trigger-width] p-0">
              <Command>
                <CommandInput placeholder="Search a plan..." />
                <CommandList className="overflow-hidden">
                  <CommandEmpty>No customer found.</CommandEmpty>
                  <FilterScroll>
                    <CommandGroup>
                      {isLoading && <CommandLoading>Loading...</CommandLoading>}
                      <div className="flex flex-col gap-2 pt-1">
                        {customers?.customers.map((customer) => (
                          <CommandItem
                            value={`${customer.id}`}
                            key={customer.id}
                            onSelect={() => {
                              field.onChange(customer.id)
                              setSwitcherCustomerOpen(false)
                            }}
                          >
                            <CheckIcon
                              className={cn(
                                "mr-2 h-4 w-4",
                                customer.id === field.value ? "opacity-100" : "opacity-0"
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
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
