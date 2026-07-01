"use client"

import { BorderBeam } from "@unprice/ui/border-beam"
import { Button } from "@unprice/ui/button"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unprice/ui/tabs"
import { cn } from "@unprice/ui/utils"
import { useState } from "react"
import { CodeEditor } from "./code-editor"
import CopyToClipboard from "./copy-to-clipboard"

export const codeExamples = {
  sdk: {
    checkAccess: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

// Check access before the paid action runs.
const { result, error } = await unprice.access.check({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  featureSlug: "tokens",
})

if (error) {
  console.error(error.message)
  return
}

if (!result.allowed) {
  throw new Error("Denied before paid usage ran")
}
`,
    recordUsage: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

// Record usage for asynchronous ingestion.
const { result, error } = await unprice.usage.record({
  idempotencyKey: crypto.randomUUID(),
  eventSlug: "tokens_used",
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  properties: {
    tokens: 3842,
  },
})

if (error) {
  console.error(error.message)
  return
}
`,
    consumeUsage: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

// Consume usage when the request path needs a decision.
const { result, error } = await unprice.usage.consume({
  idempotencyKey: crypto.randomUUID(),
  eventSlug: "tokens_used",
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  featureSlug: "tokens",
  properties: {
    tokens: 3842,
  },
})

if (error) {
  console.error(error.message)
  return
}

if (!result.allowed) {
  throw new Error(result.message ?? "Usage denied")
}
`,
    signUpCustomer: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.customers.signUp({
  name: "Acme Inc.",
  email: "billing@acme.test",
  planVersionId: "plan_version_1GTzSGrapiBW1QwCL3Fcn",
  successUrl: "http://your-app.com/dashboard",
  cancelUrl: "http://your-app.com/failed",
})

if (error) {
  console.error(error.message)
  return
}

const customerId = result.customerId

// Redirect to checkout when the plan requires payment.
redirect(result.url ?? "/")
`,
    listEntitlements: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.access.entitlements.list({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
})

if (error) {
  console.error(error.message)
  return
}
`,
    getWalletBalance: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.wallet.balance({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
})

if (error) {
  console.error(error.message)
  return
}
`,
    getSubscription: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.subscriptions.get({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
})

if (error) {
  console.error(error.message)
  return
}

console.log(result)
`,
    getUsage: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.analytics.usage.get({
  project_id: "project_1GTzSGrapiBW1QwCL3Fcn",
  customer_id: "cus_1GTzSGrapiBW1QwCL3Fcn",
  range: "30d",
})

if (error) {
  console.error(error.message)
  return
}
`,
    getPaymentMethods: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.paymentMethods.list({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  provider: "stripe",
})
`,
    createPaymentMethod: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

const { result, error } = await unprice.paymentMethods.create({
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

const { result, error } = await unprice.planVersions.list({
  billingInterval: "month",
  currency: "USD",
})
`,
    startBudgetedRun: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

// Start a budgeted run before the workload creates cost,
// then consume usage and end the run.
const { result: run, error: startError } = await unprice.runs.start({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  budgetAmount: 5000,
  idempotencyKey: crypto.randomUUID(),
  workloadType: "workflow",
  workloadId: "daily-report",
})

if (startError) {
  console.error(startError.message)
  return
}

let finalStatus: "completed" | "failed" = "completed"

try {
  // Run your workload here, then report the usage it created.
  const { result: usage, error: consumeError } = await unprice.runs.consume({
    runId: run.runId,
    featureSlug: "tokens",
    eventSlug: "tokens_used",
    idempotencyKey: crypto.randomUUID(),
    properties: {
      tokens: 3842,
    },
  })

  if (consumeError) {
    throw new Error(consumeError.message)
  }

  if (!usage.accepted) {
    throw new Error(usage.reason)
  }
} catch (error) {
  finalStatus = "failed"
  throw error
} finally {
  // End the run so unused reservation funds are released.
  const { error: endError } = await unprice.runs.end({
    runId: run.runId,
    status: finalStatus,
  })

  if (endError) {
    console.error(endError.message)
  }
}
`,
    applyRunUsage: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

// Apply usage to a running budgeted run.
const { result, error } = await unprice.runs.consume({
  runId: "run_1GTzSGrapiBW1QwCL3Fcn",
  featureSlug: "tokens",
  eventSlug: "tokens_used",
  idempotencyKey: crypto.randomUUID(),
  properties: {
    tokens: 3842,
  },
})

if (error) {
  console.error(error.message)
  return
}

if (!result.accepted) {
  throw new Error(result.reason)
}
`,
    endBudgetedRun: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

// End a budgeted run and release unused reservation funds.
const { result, error } = await unprice.runs.end({
  runId: "run_1GTzSGrapiBW1QwCL3Fcn",
  status: "completed",
})

if (error) {
  console.error(error.message)
  return
}
`,
    explainCharge: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
})

// Explain an invoice charge from rated usage and ledger evidence.
const { result, error } = await unprice.analytics.charges.explain({
  invoice_id: "inv_1GTzSGrapiBW1QwCL3Fcn",
  entry_id: "entry_1GTzSGrapiBW1QwCL3Fcn",
})

if (error) {
  console.error(error.message)
  return
}
`,
  },
  fetch: {
    checkAccess: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/access/check", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
    featureSlug: "tokens",
  }),
})`,
    recordUsage: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/usage/record", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    idempotencyKey: crypto.randomUUID(),
    eventSlug: "tokens_used",
    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
    properties: {
      tokens: 3842,
    },
  }),
})`,
    consumeUsage: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/usage/consume", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    idempotencyKey: crypto.randomUUID(),
    eventSlug: "tokens_used",
    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
    featureSlug: "tokens",
    properties: {
      tokens: 3842,
    },
  }),
})`,
    signUpCustomer: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/customers/sign-up", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    name: "Acme Inc.",
    email: "billing@acme.test",
    planVersionId: "plan_version_1GTzSGrapiBW1QwCL3Fcn",
    successUrl: "http://your-app.com/dashboard",
    cancelUrl: "http://your-app.com/failed",
  }),
})`,
    listEntitlements: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/access/entitlements/list", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  }),
})`,
    getWalletBalance: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/wallet/balance?customerId=cus_1GTzSGrapiBW1QwCL3Fcn", {
  method: "GET",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
})`,
    getSubscription: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/subscriptions/get", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  }),
})`,
    getUsage: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/analytics/usage/get", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    project_id: "project_1GTzSGrapiBW1QwCL3Fcn",
    customer_id: "cus_1GTzSGrapiBW1QwCL3Fcn",
    range: "30d",
  }),
})`,
    getPaymentMethods: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/payment-methods/list", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
    provider: "stripe",
  }),
})`,
    createPaymentMethod: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/payment-methods/create", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    paymentProvider: "stripe",
    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
    successUrl: "http://your-app.com/dashboard",
    cancelUrl: "http://your-app.com/failed",
  }),
})`,
    listPlanVersions: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/plan-versions/list", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    billingInterval: "month",
    currency: "USD",
  }),
})`,
    startBudgetedRun: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

const startResponse = await fetch(baseUrl + "/v1/runs/start", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
    budgetAmount: 5000,
    idempotencyKey: crypto.randomUUID(),
    workloadType: "workflow",
    workloadId: "daily-report",
  }),
})

if (!startResponse.ok) {
  throw new Error(await startResponse.text())
}

const run = await startResponse.json()
let finalStatus = "completed"

try {
  const consumeResponse = await fetch(baseUrl + "/v1/runs/consume/" + run.runId, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      featureSlug: "tokens",
      eventSlug: "tokens_used",
      idempotencyKey: crypto.randomUUID(),
      properties: {
        tokens: 3842,
      },
    }),
  })

  if (!consumeResponse.ok) {
    throw new Error(await consumeResponse.text())
  }

  const usage = await consumeResponse.json()

  if (!usage.accepted) {
    throw new Error(usage.reason)
  }
} catch (error) {
  finalStatus = "failed"
  throw error
} finally {
  await fetch(baseUrl + "/v1/runs/end/" + run.runId, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      status: finalStatus,
    }),
  })
}`,
    applyRunUsage: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/runs/consume/run_1GTzSGrapiBW1QwCL3Fcn", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    featureSlug: "tokens",
    eventSlug: "tokens_used",
    idempotencyKey: crypto.randomUUID(),
    properties: {
      tokens: 3842,
    },
  }),
})`,
    endBudgetedRun: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/runs/end/run_1GTzSGrapiBW1QwCL3Fcn", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    status: "completed",
  }),
})`,
    explainCharge: `const baseUrl = "https://api.unprice.dev"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/analytics/charges/explain", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    invoice_id: "inv_1GTzSGrapiBW1QwCL3Fcn",
    entry_id: "entry_1GTzSGrapiBW1QwCL3Fcn",
  }),
})`,
  },
}

export type method = keyof typeof codeExamples.sdk

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
  startBudgetedRun: "Start budgeted run",
  applyRunUsage: "Apply run usage",
  endBudgetedRun: "End budgeted run",
  explainCharge: "Explain charge",
}

export function SDKDemo({
  className,
  defaultMethod,
  showBorderBeam = true,
  presentation = "marketing",
}: {
  className?: string
  defaultMethod?: method
  showBorderBeam?: boolean
  presentation?: "marketing" | "panel"
}) {
  const [activeFramework, setActiveFramework] = useState<keyof typeof codeExamples>("sdk")
  const [activeMethod, setActiveMethod] = useState<method>(defaultMethod ?? "checkAccess")
  const isPanel = presentation === "panel"

  let methods = Object.keys(codeExamples[activeFramework]) as method[]

  if (defaultMethod) {
    methods = [defaultMethod]
  }

  const code = codeExamples[activeFramework][activeMethod] ?? codeExamples.sdk.checkAccess

  return (
    <div
      className={cn(
        isPanel
          ? "relative flex w-full flex-col overflow-hidden rounded-lg border border-background-border bg-background shadow-none"
          : "relative mx-auto mt-12 flex w-full max-w-6xl flex-col items-center justify-center rounded-2xl border bg-background shadow-primary-line shadow-sm ring-1 ring-background-line [box-shadow:0_0_0_1px_rgba(0,0,0,.03),0_2px_4px_rgba(0,0,0,.05),0_12px_24px_rgba(0,0,0,.05)]",
        className
      )}
    >
      <Tabs
        value={activeFramework}
        onValueChange={(value) => setActiveFramework(value as keyof typeof codeExamples)}
        className="w-full"
      >
        <div
          className={cn(
            "border-background-border border-b",
            isPanel
              ? "flex h-12 items-stretch justify-between gap-3 bg-background-bgSubtle px-3"
              : "pt-4"
          )}
        >
          <TabsList variant="line" className={cn(isPanel && "h-full border-b-0")}>
            <TabsTrigger
              value="sdk"
              className={cn(isPanel ? "flex h-full items-center px-2.5 pt-0 pb-0 text-xs" : "px-5")}
            >
              SDK TypeScript
            </TabsTrigger>
            <TabsTrigger
              value="fetch"
              className={cn(isPanel ? "flex h-full items-center px-2.5 pt-0 pb-0 text-xs" : "px-5")}
            >
              Fetch API
            </TabsTrigger>
          </TabsList>
          {isPanel && (
            <CopyToClipboard
              code={code}
              label="Copy"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1.5 self-center border-background-border bg-background-base px-2 font-normal text-background-text text-xs shadow-none hover:bg-background-bgHover"
            />
          )}
        </div>
        <TabsContent value={activeFramework} className="mt-0">
          <div className="flex flex-col md:flex-row">
            {methods.length > 1 && (
              <div
                className={cn(
                  "w-full border-b md:border-r md:border-b-0",
                  isPanel ? "bg-background-bgSubtle/60 md:w-48" : "md:w-52"
                )}
              >
                <div
                  className={cn(
                    "hide-scrollbar flex gap-2 overflow-y-auto px-2 py-0 md:flex-col",
                    isPanel ? "md:py-2" : "md:py-4"
                  )}
                >
                  {methods.map((methodKey) => (
                    <Button
                      key={methodKey}
                      variant="link"
                      onClick={() => setActiveMethod(methodKey)}
                      className={cn(
                        "flex flex-col items-start whitespace-nowrap text-left transition-colors",
                        isPanel && "h-8 rounded px-2 text-xs hover:bg-background-bgHover",
                        activeMethod === methodKey
                          ? "text-background-textContrast"
                          : "text-background-text"
                      )}
                    >
                      {methodLabels[methodKey]}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div
              className={cn(
                isPanel
                  ? "relative flex h-full w-full overflow-hidden bg-background-base font-mono text-[13px] text-background-text leading-6"
                  : "relative flex h-full w-full overflow-hidden rounded-b-3xl rounded-br-3xl bg-background-base font-mono text-background-text text-sm md:rounded-none",
                !isPanel && {
                  "md:rounded-br-3xl": methods.length > 1,
                  "md:rounded-b-3xl": methods.length === 1,
                }
              )}
            >
              {!isPanel && (
                <div className="absolute top-3 right-3 z-10">
                  <CopyToClipboard code={code} />
                </div>
              )}
              <ScrollArea
                hideScrollBar={true}
                className={cn(
                  "hide-scrollbar w-full",
                  isPanel
                    ? "[&>[data-radix-scroll-area-viewport]]:h-[calc(100vh-18rem)] [&>[data-radix-scroll-area-viewport]]:max-h-[30rem] [&>[data-radix-scroll-area-viewport]]:min-h-[24rem] sm:[&>[data-radix-scroll-area-viewport]]:h-[calc(100vh-16rem)]"
                    : "[&>[data-radix-scroll-area-viewport]]:h-full md:[&>[data-radix-scroll-area-viewport]]:h-[35rem]",
                  "[&>[data-radix-scroll-area-viewport]]:w-full"
                )}
              >
                <CodeEditor
                  codeBlock={code}
                  language={"typescript"}
                  className={cn(isPanel && "px-3 py-4 text-[13px] leading-6")}
                  lineNumberClassName={cn(isPanel && "w-8 pr-3 text-background-text/25")}
                />
              </ScrollArea>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {showBorderBeam && <BorderBeam duration={5} size={300} />}
    </div>
  )
}
