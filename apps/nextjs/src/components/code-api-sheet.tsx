"use client"

import { useState } from "react"

import { DOCS_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@unprice/ui/sheet"
import { Code, FileCode2 } from "lucide-react"
import Link from "next/link"
import { SDKDemo, type SDKExampleParams, type method } from "~/components/landing/sdk-examples"

export function CodeApiSheet({
  children,
  defaultMethod,
  exampleParams,
}: {
  children?: React.ReactNode
  defaultMethod?: method
  exampleParams?: SDKExampleParams
}) {
  const [isOpen, setIsOpen] = useState(false)

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
        <SDKDemo
          className="bg-background-base"
          defaultMethod={defaultMethod}
          exampleParams={exampleParams}
          presentation="panel"
          showBorderBeam={false}
        />
        <SheetFooter className="border-background-border border-t pt-4">
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
