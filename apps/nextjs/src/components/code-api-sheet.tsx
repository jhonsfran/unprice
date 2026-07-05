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
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Code, FileCode2, KeyRound } from "lucide-react"
import Link from "next/link"
import { SDKDemo, type SDKExampleParams, type method } from "~/components/landing/sdk-examples"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

export function CodeApiSheet({
  children,
  defaultMethod,
  exampleParams,
}: {
  children?: React.ReactNode
  defaultMethod?: method
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
        <AnimatePresence initial={false}>
          {!apiToken && (
            <motion.div
              key="sdk-example-token-notice"
              initial={shouldReduceMotion ? { opacity: 1 } : { height: 0, opacity: 0, y: -4 }}
              animate={shouldReduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1, y: 0 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0, y: -4 }}
              transition={{
                duration: shouldReduceMotion ? 0.01 : 0.18,
                ease: [0.25, 1, 0.5, 1],
              }}
              className="overflow-hidden"
            >
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
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div
          layout={!shouldReduceMotion}
          transition={{
            duration: shouldReduceMotion ? 0.01 : 0.22,
            ease: [0.25, 1, 0.5, 1],
          }}
        >
          <SDKDemo
            className="bg-background-base"
            defaultMethod={defaultMethod}
            exampleParams={resolvedExampleParams}
            frameworks={["sdk", "fetch", "curl"]}
            presentation="panel"
            showBorderBeam={false}
          />
        </motion.div>
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
