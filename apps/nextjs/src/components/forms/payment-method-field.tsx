"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { PaymentProvider } from "@unprice/db/validators"
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@unprice/ui/form"
import { RadioGroup, RadioGroupItem } from "@unprice/ui/radio-group"
import { Separator } from "@unprice/ui/separator"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { useParams, useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import type { FieldErrors, FieldPath, FieldValues, PathValue, UseFormReturn } from "react-hook-form"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useTRPC } from "~/trpc/client"
import { PaymentMethodButton } from "./payment-method-form"

interface FormValues extends FieldValues {
  customerId?: string
  paymentMethodId?: string | null
}

function getErrorMessage(errors: FieldErrors<FieldValues>, field: string): string | undefined {
  const error = errors[field as keyof typeof errors]
  return error && typeof error === "object" && "message" in error
    ? (error.message as string)
    : undefined
}

export default function PaymentMethodsFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
  paymentProviderRequired,
  withSeparator,
  paymentProvider,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
  paymentProviderRequired?: boolean
  withSeparator?: boolean
  paymentProvider: PaymentProvider
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const workspaceSlug = useParams().workspaceSlug as string
  const projectSlug = useParams().projectSlug as string
  const searchParams = useSearchParams()
  const customerId = form.watch("customerId" as FieldPath<TFieldValues>) as string | undefined

  // Derive whether the user just returned from the payment-provider redirect
  const paymentSetup = searchParams.get("paymentSetup")
  const returnedProvider = searchParams.get("provider")
  const isReturningFromSetup =
    paymentSetup === "success" && returnedProvider === paymentProvider && !!customerId

  // User-intent state: they started (or returned from) payment provider setup
  const [awaitingPaymentSetup, setAwaitingPaymentSetup] = useState(isReturningFromSetup)
  const [confirmationTimedOut, setConfirmationTimedOut] = useState(false)

  const subscriptionReturnUrl = `/${workspaceSlug}/${projectSlug}/customers/subscriptions/new?customerId=${customerId ?? ""}&provider=${paymentProvider}`
  const successUrl = `${subscriptionReturnUrl}&paymentSetup=success`
  const cancelUrl = `${subscriptionReturnUrl}&paymentSetup=cancelled`

  const { errors } = form.formState
  const paymentMethodsInput = useMemo(
    () => ({
      customerId: customerId ?? "",
      provider: paymentProvider,
      ...(awaitingPaymentSetup ? { skipCache: true } : {}),
    }),
    [customerId, paymentProvider, awaitingPaymentSetup]
  )

  const { data, isLoading } = useQuery(
    trpc.customers.listPaymentMethods.queryOptions(paymentMethodsInput, {
      enabled: !!customerId,
      placeholderData: (previousData) => previousData,
      refetchInterval: awaitingPaymentSetup && !confirmationTimedOut ? 2000 : false,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: awaitingPaymentSetup ? 0 : 1000 * 30,
    })
  )

  const hasPaymentMethods = (data?.paymentMethods.length ?? 0) > 0
  // Derived: actively confirming = user started setup + no methods yet + not timed out
  const isConfirmingPaymentMethod =
    awaitingPaymentSetup && !hasPaymentMethods && !confirmationTimedOut
  const shouldShowCheckingState = isLoading && !data
  const shouldShowConfirmingState = isConfirmingPaymentMethod && !hasPaymentMethods

  useEffect(() => {
    if (!awaitingPaymentSetup || confirmationTimedOut) return

    const timeout = window.setTimeout(() => {
      setConfirmationTimedOut(true)
    }, 90_000)

    return () => window.clearTimeout(timeout)
  }, [awaitingPaymentSetup, confirmationTimedOut])

  useEffect(() => {
    const defaultPaymentMethod = data?.paymentMethods.at(0)
    if (!customerId || !defaultPaymentMethod) return

    queryClient.setQueryData(
      trpc.customers.listPaymentMethods.queryKey({
        customerId,
        provider: paymentProvider,
      }),
      data
    )

    const currentPaymentMethodId = form.getValues("paymentMethodId" as FieldPath<TFieldValues>)
    const hasCurrentPaymentMethod =
      typeof currentPaymentMethodId === "string" &&
      (data?.paymentMethods.some((method) => method.id === currentPaymentMethodId) ?? false)

    if (!hasCurrentPaymentMethod) {
      form.setValue(
        "paymentMethodId" as FieldPath<TFieldValues>,
        defaultPaymentMethod.id as PathValue<TFieldValues, FieldPath<TFieldValues>>,
        {
          shouldDirty: true,
          shouldValidate: true,
        }
      )
    }
  }, [customerId, data, form, paymentProvider, queryClient, trpc.customers.listPaymentMethods])

  // if payment method is not required, hide the field
  if (!paymentProviderRequired) {
    return null
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {withSeparator && <Separator className="my-2" />}
      <div className="flex flex-col gap-2">
        <FormLabel
          className={cn({
            "text-destructive": errors.paymentMethodId,
          })}
        >
          <Typography variant="h5">Payment method</Typography>
        </FormLabel>

        <FormDescription>
          Select the payment method you want to use for this subscription.
        </FormDescription>

        {errors.paymentMethodId && (
          <FormMessage>{getErrorMessage(errors, "paymentMethodId")}</FormMessage>
        )}
      </div>
      {hasPaymentMethods && (
        <FormField
          control={form.control}
          name={"paymentMethodId" as FieldPath<TFieldValues>}
          render={({ field }) => (
            <FormItem className="w-full space-y-1">
              <RadioGroup
                onValueChange={(value) => {
                  field.onChange(value)
                }}
                value={field.value ?? ""}
                className="flex flex-col gap-4 pt-2"
                disabled={isDisabled}
              >
                {/* // TODO: add payment method link */}
                {data?.paymentMethods.map((method) => (
                  <FormItem key={method.id}>
                    <FormLabel
                      htmlFor={`radio-${method.id}`}
                      className="[&:has([data-state=checked])>div]:border-primary-border [&:has([data-state=checked])>div]:shadow-sm"
                    >
                      <FormControl>
                        <RadioGroupItem
                          id={`radio-${method.id}`}
                          value={method.id}
                          className="sr-only"
                          disabled={isDisabled}
                          checked={field.value === method.id}
                        />
                      </FormControl>
                      {/* biome-ignore lint/a11y/useKeyWithClickEvents: <explanation> */}
                      <div
                        onClick={() => {
                          if (isDisabled) return
                          field.onChange(method.id)
                        }}
                        className="cursor-pointer items-center rounded-md border-2 border-muted p-6 hover:border-background-bgActive"
                      >
                        <div className="flex flex-row items-center justify-between">
                          <div className="inline-flex gap-2">
                            <span>{method?.brand}</span>
                            <span>**** **** **** {method?.last4}</span>
                          </div>
                          <div className="inline-flex gap-2">
                            <span>Expires</span>
                            <span>
                              {method?.expMonth?.toLocaleString("en-US", {
                                minimumIntegerDigits: 2,
                              })}
                              /{method?.expYear}
                            </span>
                          </div>
                        </div>
                      </div>
                    </FormLabel>
                  </FormItem>
                ))}
              </RadioGroup>
            </FormItem>
          )}
        />
      )}
      {!hasPaymentMethods && (
        <EmptyPlaceholder className="min-h-[128px]">
          <EmptyPlaceholder.Title>
            {shouldShowCheckingState
              ? "Checking payment methods"
              : shouldShowConfirmingState
                ? "Confirming payment method"
                : confirmationTimedOut
                  ? "Payment method not found yet"
                  : "No payment methods found"}
          </EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description className="mt-0">
            {shouldShowCheckingState
              ? "Loading saved payment methods from the provider."
              : shouldShowConfirmingState
                ? "Finish the provider setup. This will refresh automatically once the method is available."
                : confirmationTimedOut
                  ? "The provider finished slowly or the setup was cancelled. You can retry the lookup or add a method again."
                  : "Add a payment method before creating this subscription."}
          </EmptyPlaceholder.Description>
          <EmptyPlaceholder.Action>
            <PaymentMethodButton
              customerId={customerId ?? ""}
              successUrl={successUrl}
              cancelUrl={cancelUrl}
              paymentProvider={paymentProvider}
              hasPaymentMethods={hasPaymentMethods}
              isRefreshing={shouldShowConfirmingState}
              onProviderSessionStarted={() => {
                setConfirmationTimedOut(false)
                setAwaitingPaymentSetup(true)
              }}
            />
          </EmptyPlaceholder.Action>
        </EmptyPlaceholder>
      )}
    </div>
  )
}
