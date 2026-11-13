"use client"

import { Button } from "@unprice/ui/button"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unprice/ui/tabs"
import { cn } from "@unprice/ui/utils"
import {
  Activity,
  ChartColumn,
  CirclePlus,
  CreditCard,
  Gauge,
  Layers,
  ListChecks,
  type LucideIcon,
  Receipt,
  Repeat,
  ShieldCheck,
  UserPlus,
  Wallet,
} from "lucide-react"
import { useState } from "react"
import { CodeEditor } from "../landing/code-editor"
import CopyToClipboard from "../landing/copy-to-clipboard"

import {
  DEFAULT_FRAMEWORKS,
  type Framework,
  METHOD_ORDER,
  type SDKExampleParams,
  getCodeExample,
  getDisplayCode,
  type method,
} from "./sdk-examples-code"

export type { SDKExampleParams, method } from "./sdk-examples-code"

// ─────────────────────────────────────────────────────────────────────────────
// Display metadata
// ─────────────────────────────────────────────────────────────────────────────

const methodLabels: Record<method, string> = {
  checkAccess: "Check access",
  recordUsage: "Record usage",
  consumeUsage: "Consume usage",
  signUpCustomer: "Sign up customer",
  listEntitlements: "List entitlements",
  getWalletBalance: "Get wallet balance",
  getSubscription: "Get subscription",
  getUsage: "Get usage",
  getPaymentMethods: "List payment methods",
  createPaymentMethod: "Create payment method",
  listPlanVersions: "List plan versions",
  explainCharge: "Explain charge",
}

const methodIcons: Record<method, LucideIcon> = {
  checkAccess: ShieldCheck,
  recordUsage: Activity,
  consumeUsage: Gauge,
  signUpCustomer: UserPlus,
  listEntitlements: ListChecks,
  getWalletBalance: Wallet,
  getSubscription: Repeat,
  getUsage: ChartColumn,
  getPaymentMethods: CreditCard,
  createPaymentMethod: CirclePlus,
  listPlanVersions: Layers,
  explainCharge: Receipt,
}

const frameworkLabels: Record<Framework, string> = {
  sdk: "TypeScript SDK",
  fetch: "Fetch API",
  curl: "cURL",
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function SDKDemo({
  className,
  defaultMethod,
  methods: methodsProp,
  exampleParams,
  frameworks = DEFAULT_FRAMEWORKS,
}: {
  className?: string
  defaultMethod?: method
  methods?: method[]
  exampleParams?: SDKExampleParams
  frameworks?: Framework[]
}) {
  const [activeFramework, setActiveFramework] = useState<Framework>(frameworks[0] ?? "sdk")
  const [activeMethod, setActiveMethod] = useState<method>(
    defaultMethod ?? methodsProp?.[0] ?? "checkAccess"
  )

  let methods = methodsProp ?? METHOD_ORDER

  // defaultMethod alone locks the demo to one method; passing methods keeps
  // the switcher and only sets the starting tab
  if (defaultMethod && !methodsProp) {
    methods = [defaultMethod]
  }

  const code = getCodeExample(activeFramework, activeMethod, exampleParams)
  const displayCode = getDisplayCode(code, exampleParams)
  const language = activeFramework === "curl" ? "bash" : "typescript"

  return (
    <div
      className={cn(
        "relative flex w-full flex-col overflow-hidden rounded-lg border border-background-border bg-surface-panel shadow-ambient",
        className
      )}
    >
      <Tabs
        value={activeFramework}
        onValueChange={(value) => setActiveFramework(value as Framework)}
        className="w-full"
      >
        <div className="flex h-12 items-stretch justify-between gap-3 border-background-border border-b bg-background-bgSubtle px-3">
          <TabsList variant="line" className="h-full border-b-0">
            {frameworks.map((framework) => (
              <TabsTrigger
                key={framework}
                value={framework}
                className="flex h-full items-center px-2.5 pt-0 pb-0 text-xs"
              >
                {frameworkLabels[framework]}
              </TabsTrigger>
            ))}
          </TabsList>
          <CopyToClipboard
            code={code}
            label="Copy"
            variant="ghost"
            size="sm"
            className="h-7 min-w-[4.75rem] shrink-0 gap-1.5 self-center px-2 font-normal text-xs"
          />
        </div>
        <TabsContent value={activeFramework} className="mt-0">
          <div className="flex flex-col md:flex-row">
            {methods.length > 1 && (
              <div className="w-full border-background-border border-b bg-background-bgSubtle md:w-48 md:border-r md:border-b-0">
                <div className="hide-scrollbar flex gap-1 overflow-y-auto px-2 py-2 md:flex-col">
                  {methods.map((methodKey) => {
                    const isActive = activeMethod === methodKey
                    const MethodIcon = methodIcons[methodKey]
                    return (
                      <Button
                        key={methodKey}
                        variant="ghost"
                        aria-pressed={isActive}
                        onClick={() => setActiveMethod(methodKey)}
                        className={cn(
                          "h-8 shrink-0 justify-start gap-2 whitespace-nowrap rounded-md px-2 text-left text-xs transition-colors",
                          isActive
                            ? "bg-background-bgActive font-medium text-background-textContrast"
                            : "font-normal"
                        )}
                      >
                        <MethodIcon aria-hidden="true" className="size-3.5 shrink-0" />
                        {methodLabels[methodKey]}
                      </Button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="relative flex h-full w-full overflow-hidden bg-background-base">
              <ScrollArea
                hideScrollBar={true}
                className="hide-scrollbar w-full [&>[data-radix-scroll-area-viewport]]:h-[calc(100vh-18rem)] [&>[data-radix-scroll-area-viewport]]:max-h-[37rem] [&>[data-radix-scroll-area-viewport]]:min-h-[24rem] [&>[data-radix-scroll-area-viewport]]:w-full sm:[&>[data-radix-scroll-area-viewport]]:h-[calc(100vh-16rem)]"
              >
                <CodeEditor codeBlock={displayCode} language={language} className="px-3 py-4" />
              </ScrollArea>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
