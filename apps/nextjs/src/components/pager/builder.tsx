"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation } from "@tanstack/react-query"
import { type Page, pageInsertBaseSchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Card, CardContent } from "@unprice/ui/card"
import { Form } from "@unprice/ui/form"
import { toast } from "@unprice/ui/sonner"
import { Save } from "lucide-react"
import { useEffect, useRef } from "react"
import { useForm } from "react-hook-form"
import { useDebounce } from "~/hooks/use-debounce"
import { useTRPC } from "~/trpc/client"
import { BasicInformation } from "./basic-information"
import { ColorPalettePicker } from "./color-palette-picker"
import { FAQSection } from "./faq-section"
import { LogoUpload } from "./logo-upload"
import { PlanSelection } from "./plan-selection"

export default function PageBuilderConfig({ page }: { page: Page }) {
  const trpc = useTRPC()
  const form = useForm<Page>({
    resolver: zodResolver(pageInsertBaseSchema),
    defaultValues: {
      ...page,
    },
  })

  const initialValuesRef = useRef(page)
  const lastSavedValuesRef = useRef<Page>(page)

  const { mutateAsync: updatePage, isPending } = useMutation(
    trpc.pages.update.mutationOptions({
      onSuccess: () => {
        toast.success("Configuration saved successfully!", {
          description: "Your page builder settings have been saved.",
        })
        initialValuesRef.current = lastSavedValuesRef.current
      },
    })
  )

  const handleSaveConfig = async (data: Page) => {
    lastSavedValuesRef.current = data

    // if form is invalid don't save
    if (Object.keys(form.formState.errors).length > 0) {
      return
    }

    await updatePage({
      ...data,
    })
  }

  const watchedValues = form.watch()
  const debouncedValues = useDebounce(watchedValues, 5000) // 5s debounce
  const isFirstRender = useRef(true)

  // primitive auto save
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }

    // Only save if values actually changed
    if (JSON.stringify(debouncedValues) !== JSON.stringify(initialValuesRef.current)) {
      handleSaveConfig(debouncedValues)
    }
  }, [debouncedValues])

  return (
    <div className="flex flex-col">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSaveConfig)} className="space-y-8">
          <div className="grid gap-8 lg:grid-cols-2">
            {/* Configuration Form */}
            <div className="space-y-6">
              <BasicInformation control={form.control} />
              <PlanSelection
                control={form.control}
                setValue={form.setValue}
                getValues={form.getValues}
                watch={form.watch}
              />
              <FAQSection setValue={form.setValue} getValues={form.getValues} />
            </div>
            <div className="space-y-6">
              <LogoUpload
                control={form.control}
                setValue={form.setValue}
                getValues={form.getValues}
              />
              <ColorPalettePicker
                control={form.control}
                setValue={form.setValue}
                watch={form.watch}
              />
              <Card>
                <CardContent className="pt-6">
                  <Button
                    onClick={form.handleSubmit(handleSaveConfig)}
                    className="w-full"
                    disabled={isPending}
                  >
                    <Save className="mr-2 h-4 w-4" />
                    {isPending ? "Saving..." : "Save Configuration"}
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        </form>
      </Form>
    </div>
  )
}
