"use client"

import { add, endOfDay, format } from "date-fns"
import { type Dispatch, type SetStateAction, useState } from "react"
import type { UseFormReturn } from "react-hook-form"

import type { CreateApiKey } from "@unprice/db/validators"
import { createApiKeySchema } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Calendar } from "@unprice/ui/calendar"
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
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@unprice/ui/form"
import { Calendar as CalendarIcon, Eye, EyeOff } from "@unprice/ui/icons"
import { Input } from "@unprice/ui/input"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"

import { useMutation, useQuery } from "@tanstack/react-query"
import { cn } from "@unprice/ui/utils"
import { motion } from "framer-motion"
import { CheckIcon, ChevronDown } from "lucide-react"
import { useParams, useSearchParams } from "next/navigation"
import { revalidateAppPath } from "~/actions/revalidate"
import { CopyButton } from "~/components/copy-button"
import { FilterScroll } from "~/components/filter-scroll"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

type CreateApiKeyFormProps = {
  isOnboarding?: boolean
  setDialogOpen?: (open: boolean) => void
  onSuccess?: (key: string) => void
  defaultValues?: CreateApiKey
  skip?: boolean
  onSkip?: () => void
}

type CreateApiKeyFormState = UseFormReturn<CreateApiKey>
type CustomerOption = RouterOutputs["customers"]["listByActiveProject"]["customers"][number]

export default function CreateApiKeyForm(props: CreateApiKeyFormProps) {
  const trpc = useTRPC()

  const [show, setShow] = useState(false)
  const [key, setKey] = useState<string | null>(null)
  const params = useParams()
  const searchParams = useSearchParams()

  const workspaceSlug = params.workspaceSlug as string
  let projectSlug = params.projectSlug as string

  if (!projectSlug) {
    projectSlug = searchParams.get("projectSlug") as string
  }

  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [switcherCustomerOpen, setSwitcherCustomerOpen] = useState(false)

  const form = useZodForm({
    schema: createApiKeySchema,
    defaultValues: {
      name: props.defaultValues?.name ?? "",
      expiresAt: props.defaultValues?.expiresAt ?? null,
      defaultCustomerId: props.defaultValues?.defaultCustomerId ?? null,
    },
  })

  const { data: customersData, isLoading: isCustomersLoading } = useQuery(
    trpc.customers.listByActiveProject.queryOptions({
      search: null,
      from: null,
      to: null,
      page: 1,
      page_size: 1_000,
    })
  )
  const customers = customersData?.customers ?? []
  const defaultCustomerId = form.watch("defaultCustomerId")
  const selectedCustomer = customers.find((customer) => customer.id === defaultCustomerId)

  const create = useMutation(
    trpc.apikeys.create.mutationOptions({
      onSuccess: (data) => {
        toastAction("success")
        setKey(data.apikey.key ?? null)
        props.onSuccess?.(data.apikey.key ?? "")
      },
    })
  )

  const resetForm = () => {
    setKey(null)
    form.reset()
    props.setDialogOpen?.(false)
    props.onSuccess?.("")
    revalidateAppPath(`/${workspaceSlug}/${projectSlug}/apikeys`, "page")
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(async (data: CreateApiKey) => await create.mutateAsync(data))}
        className="space-y-6"
      >
        {key && <ApiKeyCreatedSecret apiKey={key} show={show} onShowChange={setShow} />}
        {!key && (
          <CreateApiKeyFields
            form={form}
            customers={customers}
            isCustomersLoading={isCustomersLoading}
            selectedCustomer={selectedCustomer}
            switcherCustomerOpen={switcherCustomerOpen}
            setSwitcherCustomerOpen={setSwitcherCustomerOpen}
            datePickerOpen={datePickerOpen}
            setDatePickerOpen={setDatePickerOpen}
          />
        )}

        <CreateApiKeyFormActions
          hasCreatedKey={Boolean(key)}
          skip={props.skip}
          isSubmitting={form.formState.isSubmitting}
          onSkip={() => {
            props.setDialogOpen?.(false)
            props.onSkip?.()
          }}
          onDone={resetForm}
        />
      </form>
    </Form>
  )
}

function ApiKeyCreatedSecret({
  apiKey,
  show,
  onShowChange,
}: {
  apiKey: string
  show: boolean
  onShowChange: (show: boolean) => void
}) {
  return (
    <>
      <div
        role="alert"
        className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
      >
        Copy this secret now. For security, it will only be shown once.
      </div>
      <motion.div
        className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-background-bgSubtle px-3 py-2"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <span className={cn("min-w-0 flex-1 truncate font-mono text-sm")}>
          {show ? apiKey : maskApiKey(apiKey)}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 opacity-70"
            disabled={show}
            onClick={() => {
              onShowChange(true)
              setTimeout(() => {
                onShowChange(false)
              }, 2000)
            }}
          >
            <span className="sr-only">Toggle key visibility</span>
            {show ? <EyeOff /> : <Eye />}
          </Button>

          <CopyButton value={apiKey} className="size-4 opacity-70" />
        </div>
      </motion.div>
    </>
  )
}

function CreateApiKeyFields({
  form,
  customers,
  isCustomersLoading,
  selectedCustomer,
  switcherCustomerOpen,
  setSwitcherCustomerOpen,
  datePickerOpen,
  setDatePickerOpen,
}: {
  form: CreateApiKeyFormState
  customers: CustomerOption[]
  isCustomersLoading: boolean
  selectedCustomer?: CustomerOption
  switcherCustomerOpen: boolean
  setSwitcherCustomerOpen: Dispatch<SetStateAction<boolean>>
  datePickerOpen: boolean
  setDatePickerOpen: Dispatch<SetStateAction<boolean>>
}) {
  return (
    <div className="space-y-8">
      <ApiKeyNameField form={form} />
      <DefaultCustomerField
        form={form}
        customers={customers}
        isCustomersLoading={isCustomersLoading}
        selectedCustomer={selectedCustomer}
        open={switcherCustomerOpen}
        setOpen={setSwitcherCustomerOpen}
      />
      <ExpirationDateField form={form} open={datePickerOpen} setOpen={setDatePickerOpen} />
    </div>
  )
}

function ApiKeyNameField({ form }: { form: CreateApiKeyFormState }) {
  return (
    <FormField
      control={form.control}
      name="name"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Name</FormLabel>
          <FormDescription>
            Enter a unique name for your token to differentiate it from other tokens.
          </FormDescription>
          <FormControl>
            <Input {...field} placeholder="api-key-prod" />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function DefaultCustomerField({
  form,
  customers,
  isCustomersLoading,
  selectedCustomer,
  open,
  setOpen,
}: {
  form: CreateApiKeyFormState
  customers: CustomerOption[]
  isCustomersLoading: boolean
  selectedCustomer?: CustomerOption
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
}) {
  return (
    <FormField
      control={form.control}
      name="defaultCustomerId"
      render={({ field }) => (
        <FormItem className="flex flex-col">
          <FormLabel>Default Customer</FormLabel>
          <FormDescription>
            Optional. If set, this customer is used when requests omit `customerId`.
          </FormDescription>
          <Popover modal={true} open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <div>
                <FormControl>
                  <Button type="button" variant="outline" className={cn("w-full justify-between")}>
                    {isCustomersLoading ? (
                      <LoadingAnimation className="h-4 w-4" variant="dots" />
                    ) : selectedCustomer ? (
                      `${selectedCustomer.email} - ${selectedCustomer.name}`
                    ) : (
                      "No default customer"
                    )}
                    <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </FormControl>
              </div>
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
                            field.onChange(null)
                            setOpen(false)
                          }}
                        >
                          <CheckIcon
                            className={cn(
                              "mr-2 h-4 w-4",
                              !field.value ? "opacity-100" : "opacity-0"
                            )}
                          />
                          No default customer
                        </CommandItem>
                        {customers.map((customer) => (
                          <CommandItem
                            value={`${customer.email} ${customer.name} ${customer.id}`}
                            key={customer.id}
                            onSelect={() => {
                              field.onChange(customer.id)
                              setOpen(false)
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

function ExpirationDateField({
  form,
  open,
  setOpen,
}: {
  form: CreateApiKeyFormState
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
}) {
  return (
    <FormField
      control={form.control}
      name="expiresAt"
      render={({ field }) => (
        <FormItem className="flex flex-col">
          <FormLabel>Expiration date</FormLabel>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <FormControl>
                <Button variant={"outline"} className="pl-3 text-left font-normal">
                  {field.value ? (
                    format(field.value, "PPP")
                  ) : (
                    <span className="text-muted-foreground">Pick a date</span>
                  )}
                  <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                </Button>
              </FormControl>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={field.value ? new Date(field.value) : undefined}
                onSelect={(date) => {
                  if (!date) {
                    field.onChange(undefined)
                    setOpen(false)
                    return
                  }
                  const midnight = endOfDay(date)
                  field.onChange(midnight.getTime())
                  setOpen(false)
                }}
                disabled={(date) =>
                  // future dates up to 1 year only
                  date < new Date() || date > add(new Date(), { years: 1 })
                }
                initialFocus
              />
            </PopoverContent>
          </Popover>
          <FormDescription>
            We <b>strongly recommend</b> setting an expiration date for your API key, but you can
            also leave it blank to create a permanent key.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function CreateApiKeyFormActions({
  hasCreatedKey,
  skip,
  isSubmitting,
  onSkip,
  onDone,
}: {
  hasCreatedKey: boolean
  skip?: boolean
  isSubmitting: boolean
  onSkip: () => void
  onDone: () => void
}) {
  return (
    <div className="flex justify-end space-x-4 pt-8">
      {skip && (
        <Button type="button" variant="ghost" onClick={onSkip}>
          Skip
        </Button>
      )}
      {hasCreatedKey ? (
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      ) : (
        <SubmitButton
          type="submit"
          isSubmitting={isSubmitting}
          isDisabled={isSubmitting}
          label={"Create"}
        />
      )}
    </div>
  )
}

function maskApiKey(apiKey: string): string {
  return `${apiKey.split("_")[0]}_${apiKey.split("_")[1]}_${apiKey.split("_")[2]!.replace(/./g, "*")}`
}
