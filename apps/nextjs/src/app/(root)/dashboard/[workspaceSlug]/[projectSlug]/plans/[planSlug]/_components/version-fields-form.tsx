"use client"
import type { Currency, PaymentProvider } from "@unprice/db/validators"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Input } from "@unprice/ui/input"
import type { FieldPath, FieldValues, UseFormReturn } from "react-hook-form"

import { CURRENCIES, PAYMENT_PROVIDERS } from "@unprice/db/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Textarea } from "@unprice/ui/text-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { useParams } from "next/navigation"
import { SuperLink } from "~/components/super-link"

interface FormValues extends FieldValues {
  paymentMethodRequired: boolean
  title: string
  currency: Currency
  paymentProvider: PaymentProvider
  description: string
  trialUnits?: number
}

export function TitleFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
}) {
  return (
    <FormField
      control={form.control}
      name={"title" as FieldPath<TFieldValues>}
      render={({ field }) => (
        <FormItem className="flex flex-col justify-end">
          <div className="flex items-center gap-1">
            <FormLabel>Title</FormLabel>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[250px]">
                Customer-facing name for this version. Use different titles for multi-language
                support.
              </TooltipContent>
            </Tooltip>
          </div>
          <FormControl>
            <Input {...field} placeholder="FREE" onChange={field.onChange} disabled={isDisabled} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

export function CurrencyFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
}) {
  const { workspaceSlug, projectSlug } = useParams()

  return (
    <FormField
      control={form.control}
      name={"currency" as FieldPath<TFieldValues>}
      render={({ field }) => (
        <FormItem className="flex flex-col justify-end">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <FormLabel>Currency</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  Each plan version can have its own currency. Useful for regional pricing.
                </TooltipContent>
              </Tooltip>
            </div>
            <SuperLink
              href={`/${workspaceSlug}/${projectSlug}/settings`}
              className="inline-block text-info text-xs underline opacity-70"
            >
              Set default
            </SuperLink>
          </div>
          <Select onValueChange={field.onChange} value={field.value} disabled={isDisabled}>
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder="Select a currency" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {CURRENCIES.map((currency) => (
                <SelectItem key={currency} value={currency}>
                  {currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

interface PaymentProviderFormValues extends FieldValues {
  paymentProvider?: PaymentProvider
}

export function PaymentProviderFormField<TFieldValues extends PaymentProviderFormValues>({
  form,
  isDisabled,
  workspaceSlug,
  projectSlug,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
  workspaceSlug: string
  projectSlug: string
}) {
  return (
    <FormField
      control={form.control}
      name={"paymentProvider" as FieldPath<TFieldValues>}
      render={({ field }) => (
        <FormItem className="col-start-1 row-start-5 flex flex-col justify-end">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <FormLabel>Payment Provider</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  The payment gateway to process charges. Configure it in settings first.
                </TooltipContent>
              </Tooltip>
            </div>
            <SuperLink
              href={`/${workspaceSlug}/${projectSlug}/settings/payment`}
              className="inline-block text-info text-xs underline opacity-70"
            >
              Configure
            </SuperLink>
          </div>
          <Select onValueChange={field.onChange} value={field.value ?? ""} disabled={isDisabled}>
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {PAYMENT_PROVIDERS.map((provider) => {
                const disabled = provider === "square"
                return (
                  <SelectItem key={provider} value={provider} disabled={disabled}>
                    {disabled ? `${provider} - coming soon` : provider}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

export function DescriptionFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
}) {
  return (
    <FormField
      control={form.control}
      name={"description" as FieldPath<TFieldValues>}
      render={({ field }) => (
        <FormItem className="col-start-2 row-span-2 flex flex-col justify-start">
          <div className="flex items-center gap-1">
            <FormLabel>Description</FormLabel>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[250px]">
                Brief summary shown to customers. Explain what this version offers.
              </TooltipContent>
            </Tooltip>
          </div>
          <FormControl>
            <Textarea
              {...field}
              value={field.value ?? ""}
              className="md:min-h-[50px]"
              disabled={isDisabled}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
