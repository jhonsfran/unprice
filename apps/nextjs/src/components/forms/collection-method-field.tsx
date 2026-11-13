"use client"
import { COLLECTION_METHODS } from "@unprice/db/utils"
import type { CollectionMethod } from "@unprice/db/validators"
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import type { FieldPath, FieldValues, UseFormReturn } from "react-hook-form"
import { COLLECTION_METHOD_LABEL, COLLECTION_METHOD_NOTE } from "./billing-labels"

interface FormValues extends FieldValues {
  collectionMethod?: CollectionMethod | null
}

export default function CollectionMethodFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
}) {
  return (
    <FormField
      control={form.control}
      name={"collectionMethod" as FieldPath<TFieldValues>}
      render={({ field }) => {
        const value = (field.value ?? undefined) as CollectionMethod | undefined
        return (
          <FormItem className="flex w-full flex-col">
            <div className="flex items-center gap-1">
              <FormLabel>Collection method</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  How an invoice gets paid: charged to the payment method on file, or sent to the
                  customer to pay.
                </TooltipContent>
              </Tooltip>
            </div>
            <Select onValueChange={field.onChange} value={value ?? ""} disabled={isDisabled}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select collection method" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {/* // TODO: add send_invoice to the collection methods */}
                {COLLECTION_METHODS.filter((type) => type !== "send_invoice").map((type) => (
                  <SelectItem key={type} value={type}>
                    {COLLECTION_METHOD_LABEL[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {value && (
              <FormDescription className="text-xs">{COLLECTION_METHOD_NOTE[value]}</FormDescription>
            )}
            <FormMessage />
          </FormItem>
        )
      }}
    />
  )
}
