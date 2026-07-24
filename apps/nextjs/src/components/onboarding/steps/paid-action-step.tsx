"use client"

import { useOnboarding } from "@onboardjs/react"
import { Button } from "@unprice/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@unprice/ui/collapsible"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"
import { track } from "@vercel/analytics"
import { useParams } from "next/navigation"
import { useRef, useState } from "react"

import { SuperLink } from "~/components/super-link"
import { useZodForm } from "~/lib/zod-form"
import {
  type OnboardingFlowData,
  derivePaidActionSlugs,
  normalizePaidAction,
  paidActionFormSchema,
} from "../paid-action-schema"

const DEFAULT_ACTION = {
  title: "AI generation",
  unitPrice: "4.10",
  featureSlug: "ai-generation",
  eventSlug: "ai_generation",
  unitOfMeasure: "action" as const,
}

export function PaidActionStep() {
  const { next, state, updateContext } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const flowData = (state?.context?.flowData ?? {}) as OnboardingFlowData
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const featureSlugEdited = useRef(false)
  const eventSlugEdited = useRef(false)
  const form = useZodForm({
    schema: paidActionFormSchema,
    defaultValues: flowData.paidAction ?? DEFAULT_ACTION,
  })

  const onSubmit = form.handleSubmit(async (values) => {
    const paidAction = normalizePaidAction(values)
    await updateContext({
      flowData: {
        paidAction,
        proofError: undefined,
        proofPhase: undefined,
      },
    })
    track("onboarding_paid_action_submitted", {
      featureSlug: paidAction.featureSlug,
      eventSlug: paidAction.eventSlug,
    })
    await next()
  })

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="flex w-full flex-col gap-6">
        <div className="flex flex-col gap-5">
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Action name</FormLabel>
                <FormDescription>
                  Name the paid work your application performs for a customer.
                </FormDescription>
                <FormControl>
                  <Input
                    {...field}
                    autoComplete="off"
                    placeholder="AI generation"
                    onChange={(event) => {
                      field.onChange(event)
                      const slugs = derivePaidActionSlugs(event.target.value)
                      if (!featureSlugEdited.current) {
                        form.setValue("featureSlug", slugs.featureSlug, {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                      }
                      if (!eventSlugEdited.current) {
                        form.setValue("eventSlug", slugs.eventSlug, {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                      }
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="unitPrice"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Price per action (USD)</FormLabel>
                <FormDescription>
                  We will give the Sandbox customer enough budget for exactly one action.
                </FormDescription>
                <FormControl>
                  <Input
                    {...field}
                    autoComplete="off"
                    inputMode="decimal"
                    placeholder="4.10"
                    className="font-mono tabular-nums"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" aria-expanded={advancedOpen}>
              {advancedOpen ? "Hide advanced settings" : "Advanced settings"}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-4">
            <div className="flex flex-col gap-5 rounded-md bg-background-bgSubtle p-4">
              <FormField
                control={form.control}
                name="featureSlug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Feature slug</FormLabel>
                    <FormDescription>Used by the request-path authorization call.</FormDescription>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete="off"
                        className="font-mono"
                        onChange={(event) => {
                          featureSlugEdited.current = true
                          field.onChange(event)
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="eventSlug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Event slug</FormLabel>
                    <FormDescription>Recorded when this paid action is requested.</FormDescription>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete="off"
                        className="font-mono"
                        onChange={(event) => {
                          eventSlugEdited.current = true
                          field.onChange(event)
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-background-text">Unit</span>
                <code className="font-mono text-background-textContrast text-xs">action</code>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving paid action…" : "Create and test paid action"}
          </Button>
          <SuperLink
            href={`/${workspaceSlug}`}
            className="text-background-text text-xs transition-colors duration-quick ease-out-quad hover:text-background-textContrast"
            onClick={() => track("onboarding_skipped", { step: "paid_action" })}
          >
            Skip for now
          </SuperLink>
        </div>
      </form>
    </Form>
  )
}
