"use client"

import { add, endOfDay, format } from "date-fns"
import { useState } from "react"

import type { CreateApiKey } from "@unprice/db/validators"
import { createApiKeySchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Calendar } from "@unprice/ui/calendar"
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
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"

import { useMutation } from "@tanstack/react-query"
import { cn } from "@unprice/ui/utils"
import { motion } from "framer-motion"
import { useParams, useSearchParams } from "next/navigation"
import { revalidateAppPath } from "~/actions/revalidate"
import { CopyButton } from "~/components/copy-button"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

export default function CreateApiKeyForm(props: {
  setDialogOpen?: (open: boolean) => void
  onSuccess?: (key: string) => void
  defaultValues?: CreateApiKey
  skip?: boolean
}) {
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

  const form = useZodForm({
    schema: createApiKeySchema,
    defaultValues: {
      ...props.defaultValues,
      // from onboarding we can't infer the projectSlug, so we pass it as a search param
      ...(projectSlug ? { projectSlug } : {}),
    },
  })

  const create = useMutation(
    trpc.apikeys.create.mutationOptions({
      onSuccess: (data) => {
        toastAction("success")
        setKey(data.apikey.key ?? null)
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
        {key && (
          <motion.div
            className="flex items-center justify-between space-x-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <span className={cn("font-mono")}>
              {show
                ? key
                : `${key.split("_")[0]}_${key.split("_")[1]}_${key.split("_")[2]!.replace(/./g, "*")}`}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                className="h-4 w-4 p-0 opacity-50"
                disabled={show}
                onClick={() => {
                  setShow(true)
                  setTimeout(() => {
                    setShow(false)
                  }, 2000)
                }}
              >
                <span className="sr-only">Toggle key visibility</span>
                {show ? <EyeOff /> : <Eye />}
              </Button>

              <CopyButton value={key} className="size-4 opacity-50" onClick={resetForm} />
            </div>
          </motion.div>
        )}
        <div className="space-y-8">
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

          <FormField
            control={form.control}
            name="expiresAt"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>Exiration date</FormLabel>
                <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
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
                          setDatePickerOpen(false)
                          return
                        }
                        const midnight = endOfDay(date)
                        field.onChange(midnight.getTime())
                        setDatePickerOpen(false)
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
                  We <b>strongly recommend</b> you setting an expiration date for your API key, but
                  you can also leave it blank to create a permanent key.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end space-x-4 pt-8">
          {props.skip && (
            <Button
              variant="ghost"
              onClick={(e) => {
                e.preventDefault()
                props.setDialogOpen?.(false)
                props.onSuccess?.("")
              }}
            >
              Skip
            </Button>
          )}
          <SubmitButton
            type="submit"
            isSubmitting={form.formState.isSubmitting}
            isDisabled={form.formState.isSubmitting}
            label={"Create"}
          />
        </div>
      </form>
    </Form>
  )
}
