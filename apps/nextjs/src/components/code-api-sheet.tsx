"use client"

import { useState } from "react"

import { useMutation } from "@tanstack/react-query"
import { DOCS_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@unprice/ui/sheet"
import { LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion"
import { Code, FileCode2, KeyRound } from "lucide-react"
import Link from "next/link"
import { SDKDemo, type SDKExampleParams, type method } from "~/components/sdk-snippets/sdk-examples"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

export function CodeApiSheet({
  children,
  defaultMethod,
  methods,
  exampleParams,
}: {
  children?: React.ReactNode
  defaultMethod?: method
  // offer several methods in the sheet (defaultMethod picks the active tab)
  methods?: method[]
  exampleParams?: SDKExampleParams
}) {
  const trpc = useTRPC()
  const shouldReduceMotion = useReducedMotion()
  const [isOpen, setIsOpen] = useState(false)
  const [exampleApiToken, setExampleApiToken] = useState<string | null>(
    exampleParams?.apiToken ?? null
  )
  const apiToken = exampleParams?.apiToken ?? exampleApiToken ?? undefined
  const resolvedExampleParams =
    apiToken || exampleParams
      ? {
          ...exampleParams,
          apiToken,
        }
      : undefined

  const rollDefaultKey = useMutation(
    trpc.apikeys.rollDefaultSdkExample.mutationOptions({
      onSuccess: (data) => {
        setExampleApiToken(data.apikey.key)
        toast.success(
          data.apikey.state === "created" ? "Default key created" : "Default key rolled",
          {
            description: "The examples now include the token. The visible token stays masked.",
          }
        )
      },
    })
  )

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open)
      }}
    >
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent className="hide-scrollbar flex max-h-screen w-full flex-col justify-start gap-4 overflow-y-auto overflow-x-hidden bg-background-base px-4 py-5 sm:px-6 lg:w-[760px]">
        <SheetHeader className="gap-0 pr-8 text-left">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-background-border bg-background-bgSubtle text-background-textContrast">
              <FileCode2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <SheetTitle className="text-lg leading-7">SDK examples</SheetTitle>
              <SheetDescription className="mt-1 max-w-[58ch] text-sm leading-6">
                Copy the SDK call for this dashboard state. Use the API reference for request
                fields, responses, and errors.
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <LazyMotion features={domAnimation} strict>
          {/* no height choreography here: the animated overflow-hidden
              container could clip the roll button mid-transition */}
          {!apiToken && (
            <div className="flex flex-col items-start gap-3 px-1 py-1">
              <p className="w-full text-muted-foreground text-sm leading-6">
                <span className="font-medium text-foreground">Runnable token.</span> Roll the
                reusable example key. It expires tonight and stays masked on screen.
              </p>
              <Button
                type="button"
                size="sm"
                className="h-8 shrink-0 gap-2 px-2.5"
                disabled={rollDefaultKey.isPending}
                onClick={() => rollDefaultKey.mutate()}
              >
                {rollDefaultKey.isPending ? (
                  <LoadingAnimation />
                ) : (
                  <KeyRound className="h-3.5 w-3.5" />
                )}
                Roll example key
              </Button>
            </div>
          )}
          <m.div
            layout={!shouldReduceMotion}
            transition={{
              duration: shouldReduceMotion ? 0.01 : 0.22,
              ease: [0.25, 1, 0.5, 1],
            }}
          >
            <SDKDemo
              defaultMethod={defaultMethod}
              methods={methods}
              exampleParams={resolvedExampleParams}
              frameworks={["sdk", "fetch", "curl"]}
            />
          </m.div>
        </LazyMotion>
        <SheetFooter className="border-background-border pt-4">
          <Link href={`${DOCS_DOMAIN}/api-reference`} target="_blank" className="w-full sm:w-auto">
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-2 bg-background-base sm:w-auto"
            >
              <Code className="h-4 w-4" />
              See API reference
            </Button>
          </Link>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
