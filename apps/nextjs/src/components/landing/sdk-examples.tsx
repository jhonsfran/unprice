"use client"

import { DOCS_DOMAIN } from "@unprice/config"
import { BorderBeam } from "@unprice/ui/border-beam"
import { Button } from "@unprice/ui/button"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unprice/ui/tabs"
import { cn } from "@unprice/ui/utils"
import { ExternalLinkIcon } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { CodeEditor } from "./code-editor"
import CopyToClipboard from "./copy-to-clipboard"

// Sample code examples for different frameworks and methods
export const codeExamples = {
  sdk: {
    verifyFeature: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

// verify access to a feature
const { result, error } = await unprice.customers.can({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  featureSlug: "feature-1",
})

if (error) {
  console.error(error.message)
  return
}

if (!result.allowed) {
  console.error("Customer does not have access to feature")
}
`,
    reportUsage: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

// report usage for a feature
const { result, error } = await unprice.customers.reportUsage({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  featureSlug: "feature-1",
  usage: 30,
  idempotenceKey: "123e4567-e89b-12d3-a456-426614174000",
})
`,
    signUp: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.customers.signUp({
  name: "John Doe",
  email: "seb@unprice.dev",
  planVersionId: "plan_version_1",
  successUrl: "http://your-app.com/dashboard",
  cancelUrl: "http://your-app.com/failed",
})

if (error) {
  console.error(error.message)
  return
}

const customerId = result.customerId

// redirect to stripe checkout
redirect(result.url ?? "/")
`,
    getEntitlements: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.customers.getEntitlements("cus_1GTzSGrapiBW1QwCL3Fcn")
`,
    resetEntitlements: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.customers.resetEntitlements({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
})
`,
    getSubscription: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.customers.getSubscription("cus_1GTzSGrapiBW1QwCL3Fcn")
`,
    getUsage: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.customers.getUsage("cus_1GTzSGrapiBW1QwCL3Fcn")
`,
    getPaymentMethods: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.customers.getPaymentMethods({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  provider: "stripe",
})
`,
    createPaymentMethod: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.customers.createPaymentMethod({
  paymentProvider: "stripe",
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  successUrl: "http://your-app.com/dashboard",
  cancelUrl: "http://your-app.com/failed",
})
`,
    listPlanVersions: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.plans.listPlanVersions({
  billingInterval: "month",
  currency: "USD",
})
`,
  },
  fetch: {
    verifyFeature:
      'const baseUrl = "https://api.unprice.dev"\nconst token = process.env.UNPRICE_TOKEN\n\nawait fetch("' +
      "${baseUrl}/v1/customer/can" +
      '", {\n  method: "POST",\n  headers: {\n    Authorization: "Bearer ${token}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({\n    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",\n    featureSlug: "feature-1",\n  }),\n})',
    reportUsage:
      'const baseUrl = "https://api.unprice.dev"\nconst token = process.env.UNPRICE_TOKEN\n\nawait fetch("' +
      "${baseUrl}/v1/customer/reportUsage" +
      '", {\n  method: "POST",\n  headers: {\n    Authorization: "Bearer ${token}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({\n    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",\n    featureSlug: "feature-1",\n    usage: 30,\n    idempotenceKey: "123e4567-e89b-12d3-a456-426614174000",\n  }),\n})',
    signUp:
      'const baseUrl = "https://api.unprice.dev"\nconst token = process.env.UNPRICE_TOKEN\n\nawait fetch("' +
      "${baseUrl}/v1/customer/signUp" +
      '", {\n  method: "POST",\n  headers: {\n    Authorization: "Bearer ${token}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({\n    name: "John Doe",\n    email: "seb@unprice.dev",\n    planVersionId: "plan_version_1",\n    successUrl: "http://your-app.com/dashboard",\n    cancelUrl: "http://your-app.com/failed",\n  }),\n})',
    getEntitlements:
      'const baseUrl = "https://api.unprice.dev"\nconst token = process.env.UNPRICE_TOKEN\n\nawait fetch("' +
      "${baseUrl}/v1/customer/cus_1GTzSGrapiBW1QwCL3Fcn/getEntitlements" +
      '", {\n  method: "GET",\n  headers: {\n    Authorization: "Bearer ${token}",\n    "Content-Type": "application/json",\n  },\n})',
    resetEntitlements:
      'const baseUrl = "https://api.unprice.dev"\nconst token = process.env.UNPRICE_TOKEN\n\nawait fetch("' +
      "${baseUrl}/v1/customer/resetEntitlements" +
      '", {\n  method: "POST",\n  headers: {\n    Authorization: "Bearer ${token}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({\n    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",\n  }),\n})',
    getSubscription:
      'const baseUrl = "https://api.unprice.dev"\nconst token = process.env.UNPRICE_TOKEN\n\nawait fetch("' +
      "${baseUrl}/v1/customer/cus_1GTzSGrapiBW1QwCL3Fcn/getSubscription" +
      '", {\n  method: "GET",\n  headers: {\n    Authorization: "Bearer ${token}",\n    "Content-Type": "application/json",\n  },\n})',
    getUsage:
      'const baseUrl = "https://api.unprice.dev"\nconst token = process.env.UNPRICE_TOKEN\n\nawait fetch("' +
      "${baseUrl}/v1/customer/cus_1GTzSGrapiBW1QwCL3Fcn/getUsage" +
      '", {\n  method: "GET",\n  headers: {\n    Authorization: "Bearer ${token}",\n    "Content-Type": "application/json",\n  },\n})',
    getPaymentMethods:
      'const baseUrl = "https://api.unprice.dev"\nconst token = process.env.UNPRICE_TOKEN\n\nawait fetch("' +
      "${baseUrl}/v1/customer/getPaymentMethods" +
      '", {\n  method: "POST",\n  headers: {\n    Authorization: "Bearer ${token}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({\n    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",\n    provider: "stripe",\n  }),\n})',
    createPaymentMethod:
      'const baseUrl = "https://api.unprice.dev"\nconst token = process.env.UNPRICE_TOKEN\n\nawait fetch("' +
      "${baseUrl}/v1/customer/createPaymentMethod" +
      '", {\n  method: "POST",\n  headers: {\n    Authorization: "Bearer ${token}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({\n    paymentProvider: "stripe",\n    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",\n    successUrl: "http://your-app.com/dashboard",\n    cancelUrl: "http://your-app.com/failed",\n  }),\n})',
    listPlanVersions:
      'const baseUrl = "https://api.unprice.dev"\nconst token = process.env.UNPRICE_TOKEN\n\nawait fetch("' +
      "${baseUrl}/v1/plans/listPlanVersions" +
      '", {\n  method: "POST",\n  headers: {\n    Authorization: "Bearer ${token}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({\n    billingInterval: "month",\n    currency: "USD",\n  }),\n})',
  },
}

export type method = keyof typeof codeExamples.sdk

export function SDKDemo({
  className,
  defaultMethod,
}: { className?: string; defaultMethod?: method }) {
  const [activeFramework, setActiveFramework] = useState("sdk")
  const [activeMethod, setActiveMethod] = useState(defaultMethod ?? "verifyFeature")

  // Get the methods for the active framework
  let methods = Object.keys(codeExamples[activeFramework as keyof typeof codeExamples])

  // if defaultMethod is passed only show that method
  if (defaultMethod) {
    methods = [defaultMethod]
  }

  // Get the code for the active framework and method
  const code =
    codeExamples[activeFramework as keyof typeof codeExamples][
      activeMethod as keyof typeof codeExamples.sdk
    ] ?? codeExamples.sdk.verifyFeature

  return (
    <div
      className={cn(
        "relative mx-auto mt-12 flex w-full max-w-6xl flex-col items-center justify-center rounded-2xl border bg-background shadow-primary-line shadow-sm ring-1 ring-background-line [box-shadow:0_0_0_1px_rgba(0,0,0,.03),0_2px_4px_rgba(0,0,0,.05),0_12px_24px_rgba(0,0,0,.05)]",
        className
      )}
    >
      {/* Framework tabs */}
      <Tabs value={activeFramework} onValueChange={setActiveFramework} className="w-full">
        <div className="border-background-border border-b pt-4">
          <TabsList variant="line">
            <TabsTrigger value="sdk" className="px-5">
              SDK TypeScript
            </TabsTrigger>
            <TabsTrigger value="fetch" className="px-5">
              Fetch API
            </TabsTrigger>
            <div className="absolute top-2.5 right-2.5 flex justify-end">
              <Link href={`${DOCS_DOMAIN}/api-reference/introduction`} target="_blank">
                <Button variant="default" size="sm" className="text-xs shadow-sm">
                  API docs <ExternalLinkIcon className="ml-1 size-3" />
                </Button>
              </Link>
            </div>
          </TabsList>
        </div>
        <TabsContent value={activeFramework}>
          <div className="flex flex-col md:flex-row">
            {/* Method selection */}
            {methods.length > 1 && (
              <div className="w-full border-b md:w-52 md:border-r md:border-b-0">
                <div className="hide-scrollbar flex gap-2 overflow-y-auto px-2 py-0 md:flex-col md:py-4">
                  {methods.map((method) => (
                    <Button
                      key={method}
                      variant="link"
                      onClick={() => setActiveMethod(method as method)}
                      className={cn(
                        "flex flex-col items-start whitespace-nowrap text-left transition-colors",
                        activeMethod === method
                          ? "text-background-textContrast"
                          : "text-background-text"
                      )}
                    >
                      {/* Format method name for display */}
                      {method.replace(/([A-Z])/g, " $1").replace(/^./, (str) => str.toUpperCase())}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div
              className={cn(
                "relative flex h-full w-full overflow-hidden rounded-b-3xl rounded-br-3xl bg-background-base font-mono text-background-text text-sm md:rounded-none",
                {
                  "md:rounded-br-3xl": methods.length > 1,
                  "md:rounded-b-3xl": methods.length === 1,
                }
              )}
            >
              <div className="absolute top-3 right-3 z-10">
                <CopyToClipboard code={code} />
              </div>
              <ScrollArea
                hideScrollBar={true}
                className={cn(
                  "hide-scrollbar w-full",
                  // hack for not having to set height on scroll area
                  "[&>[data-radix-scroll-area-viewport]]:h-full md:[&>[data-radix-scroll-area-viewport]]:h-[35rem]",
                  "[&>[data-radix-scroll-area-viewport]]:w-full"
                )}
              >
                <CodeEditor codeBlock={code} language={"typescript"} />
              </ScrollArea>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <BorderBeam duration={5} size={300} />
    </div>
  )
}
