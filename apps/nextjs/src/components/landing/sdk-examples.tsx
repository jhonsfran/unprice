"use client"

import { API_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unprice/ui/tabs"
import { cn } from "@unprice/ui/utils"
import {
  Activity,
  ChartColumn,
  CirclePlay,
  CirclePlus,
  CircleStop,
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
  Zap,
} from "lucide-react"
import { useState } from "react"
import { CodeEditor } from "./code-editor"
import CopyToClipboard from "./copy-to-clipboard"

const API_BASE_URL = API_DOMAIN.replace(/\/$/, "")

export const codeExamples = {
  sdk: {
    checkAccess: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
  baseUrl: "${API_BASE_URL}",
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
  // Denied in the request path — no cost was ever created.
  throw new Error("Denied before paid usage ran")
}

// Allowed: run the paid action. The same decision
// explains the invoice line later.
`,
    recordUsage: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
  baseUrl: "${API_BASE_URL}",
})

// Report evidence without blocking the request —
// nothing is denied, everything is attributable.
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
  baseUrl: "${API_BASE_URL}",
})

// Enforce in the request path: meter the usage AND
// decide whether the paid action is allowed, in one call.
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
  baseUrl: "${API_BASE_URL}",
})

// One call provisions the customer, subscription,
// entitlements, wallet, and billing period.
// Omitting planVersionId uses the latest published version.
const { result, error } = await unprice.customers.signUp({
  name: "Acme Inc.",
  email: "billing@acme.test",
  // Optional: set a credit line to prevent over-usage.
  // creditLinePolicy: "capped",
  // creditLineAmountMinor: 10000, // capped spending to $100 for the billing period.
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
  baseUrl: "${API_BASE_URL}",
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
  baseUrl: "${API_BASE_URL}",
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
  baseUrl: "${API_BASE_URL}",
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
  baseUrl: "${API_BASE_URL}",
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
  baseUrl: "${API_BASE_URL}",
})

const { result, error } = await unprice.paymentMethods.list({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  provider: "stripe",
})
`,
    createPaymentMethod: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
  baseUrl: "${API_BASE_URL}",
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
  baseUrl: "${API_BASE_URL}",
})

const { result, error } = await unprice.planVersions.list({
  billingInterval: "month",
  currency: "USD",
})
`,
    startBudgetedRun: `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
  baseUrl: "${API_BASE_URL}",
})

// Start a budgeted run before the workload creates cost,
// then consume usage and end the run.
const { result: run, error: startError } = await unprice.runs.start({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
  budgetAmountMinor: 5000,
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
  baseUrl: "${API_BASE_URL}",
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
  baseUrl: "${API_BASE_URL}",
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
  baseUrl: "${API_BASE_URL}",
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
    checkAccess: `const baseUrl = "${API_BASE_URL}"
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
    recordUsage: `const baseUrl = "${API_BASE_URL}"
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
    consumeUsage: `const baseUrl = "${API_BASE_URL}"
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
    signUpCustomer: `const baseUrl = "${API_BASE_URL}"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/customers/sign-up", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  // Omitting planVersionId uses the latest published version of the default plan.
  body: JSON.stringify({
    name: "Acme Inc.",
    email: "billing@acme.test",
    creditLinePolicy: "capped",
    creditLineAmountMinor: 10000,
    successUrl: "http://your-app.com/dashboard",
    cancelUrl: "http://your-app.com/failed",
  }),
})`,
    listEntitlements: `const baseUrl = "${API_BASE_URL}"
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
    getWalletBalance: `const baseUrl = "${API_BASE_URL}"
const token = process.env.UNPRICE_TOKEN

await fetch(baseUrl + "/v1/wallet/balance?customerId=cus_1GTzSGrapiBW1QwCL3Fcn", {
  method: "GET",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
})`,
    getSubscription: `const baseUrl = "${API_BASE_URL}"
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
    getUsage: `const baseUrl = "${API_BASE_URL}"
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
    getPaymentMethods: `const baseUrl = "${API_BASE_URL}"
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
    createPaymentMethod: `const baseUrl = "${API_BASE_URL}"
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
    listPlanVersions: `const baseUrl = "${API_BASE_URL}"
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
    startBudgetedRun: `const baseUrl = "${API_BASE_URL}"
const token = process.env.UNPRICE_TOKEN

const startResponse = await fetch(baseUrl + "/v1/runs/start", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
    budgetAmountMinor: 5000,
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
    applyRunUsage: `const baseUrl = "${API_BASE_URL}"
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
    endBudgetedRun: `const baseUrl = "${API_BASE_URL}"
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
    explainCharge: `const baseUrl = "${API_BASE_URL}"
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
type Framework = keyof typeof codeExamples | "curl"

export type ListPlanVersionsExampleParams = {
  planVersionIds?: string[]
  billingInterval?: string
  currency?: string
  version?: number
  featureSlugs?: string[]
}

export type SDKExampleParams = {
  apiToken?: string
  customerId?: string
  listPlanVersions?: ListPlanVersionsExampleParams
  usage?: {
    eventSlug?: string
    featureSlug?: string
    aggregationMethod?: "count" | "sum" | "max" | "latest"
    aggregationField?: string | null
  }
}

const DEFAULT_CUSTOMER_ID = "cus_1GTzSGrapiBW1QwCL3Fcn"
const DEFAULT_USAGE_EVENT_SLUG = "tokens_used"
const DEFAULT_USAGE_FEATURE_SLUG = "tokens"
const DEFAULT_USAGE_AGGREGATION_FIELD = "tokens"
const DEFAULT_FRAMEWORKS = ["sdk", "fetch"] satisfies Framework[]

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
  startBudgetedRun: CirclePlay,
  applyRunUsage: Zap,
  endBudgetedRun: CircleStop,
  explainCharge: Receipt,
}

const frameworkLabels: Record<Framework, string> = {
  sdk: "TypeScript SDK",
  fetch: "Fetch API",
  curl: "cURL",
}

function stringLiteral(value: string) {
  return JSON.stringify(value)
}

function stringArrayLiteral(values: string[]) {
  return `[${values.map(stringLiteral).join(", ")}]`
}

function maskSecret(value: string) {
  const parts = value.split("_")

  if (parts.length >= 3) {
    return `${parts[0]}_${parts[1]}_${parts.slice(2).join("_").replace(/./g, "*")}`
  }

  if (value.length <= 8) {
    return value.replace(/./g, "*")
  }

  return `${value.slice(0, 4)}${value.slice(4, -4).replace(/./g, "*")}${value.slice(-4)}`
}

function getDisplayCode(code: string, params?: SDKExampleParams) {
  return params?.apiToken ? code.replaceAll(params.apiToken, maskSecret(params.apiToken)) : code
}

function getCustomerId(params?: SDKExampleParams) {
  return params?.customerId ?? DEFAULT_CUSTOMER_ID
}

function getUsageExample(params?: SDKExampleParams) {
  return {
    eventSlug: params?.usage?.eventSlug ?? DEFAULT_USAGE_EVENT_SLUG,
    featureSlug: params?.usage?.featureSlug ?? DEFAULT_USAGE_FEATURE_SLUG,
    aggregationMethod: params?.usage?.aggregationMethod ?? "sum",
    aggregationField: params?.usage?.aggregationField ?? DEFAULT_USAGE_AGGREGATION_FIELD,
  }
}

function buildUsagePropertiesObject(params?: SDKExampleParams, indent = "  ") {
  const usage = getUsageExample(params)

  if (usage.aggregationMethod === "count" || !usage.aggregationField) {
    return "{}"
  }

  return `{
${indent}${JSON.stringify(usage.aggregationField)}: 1,
}`
}

function buildUsagePropertiesJson(params?: SDKExampleParams, indent = "  ") {
  const usage = getUsageExample(params)

  if (usage.aggregationMethod === "count" || !usage.aggregationField) {
    return "{}"
  }

  return `{
${indent}${JSON.stringify(usage.aggregationField)}: 1
}`
}

function getSdkToken(params?: SDKExampleParams) {
  return params?.apiToken ? stringLiteral(params.apiToken) : "process.env.UNPRICE_TOKEN"
}

function buildSdkClientOptions(params?: SDKExampleParams) {
  return `  token: ${getSdkToken(params)},
  baseUrl: ${stringLiteral(API_BASE_URL)},`
}

function getFetchAuthorization(params?: SDKExampleParams) {
  return params?.apiToken ? stringLiteral(`Bearer ${params.apiToken}`) : '"Bearer " + token'
}

function buildFetchPreamble(params?: SDKExampleParams) {
  return params?.apiToken
    ? `const baseUrl = ${stringLiteral(API_BASE_URL)}`
    : `const baseUrl = ${stringLiteral(API_BASE_URL)}
const token = process.env.UNPRICE_TOKEN`
}

function getCurlToken(params?: SDKExampleParams) {
  return params?.apiToken ?? "$UNPRICE_TOKEN"
}

function buildPlanVersionsRequestLines(params: ListPlanVersionsExampleParams, indent = "  ") {
  const requestLines: string[] = []

  if (params.planVersionIds && params.planVersionIds.length > 0) {
    requestLines.push(`${indent}planVersionIds: ${stringArrayLiteral(params.planVersionIds)},`)
  }

  if (params.billingInterval) {
    requestLines.push(`${indent}billingInterval: ${stringLiteral(params.billingInterval)},`)
  }

  if (params.currency) {
    requestLines.push(`${indent}currency: ${stringLiteral(params.currency)},`)
  }

  return requestLines.length > 0
    ? requestLines.join("\n")
    : `${indent}billingInterval: "month",
${indent}currency: "USD",`
}

function buildPlanVersionsContextComment(params: ListPlanVersionsExampleParams) {
  const context: string[] = []

  if (params.version !== undefined) {
    context.push(`v${params.version}`)
  }

  if (params.featureSlugs && params.featureSlugs.length > 0) {
    context.push(`features: ${params.featureSlugs.map(stringLiteral).join(", ")}`)
  }

  return context.length > 0 ? `\n// Dashboard context: ${context.join("; ")}\n` : "\n"
}

function buildPlanVersionsJsonBody(params: ListPlanVersionsExampleParams) {
  const fields: Array<[string, string]> = []

  if (params.planVersionIds && params.planVersionIds.length > 0) {
    fields.push(["planVersionIds", stringArrayLiteral(params.planVersionIds)])
  }

  if (params.billingInterval) {
    fields.push(["billingInterval", stringLiteral(params.billingInterval)])
  }

  if (params.currency) {
    fields.push(["currency", stringLiteral(params.currency)])
  }

  const defaultBodyFields: Array<[string, string]> = [
    ["billingInterval", stringLiteral("month")],
    ["currency", stringLiteral("USD")],
  ]
  const bodyFields = fields.length > 0 ? fields : defaultBodyFields

  return `{
${bodyFields
  .map(
    ([key, value], index) =>
      `  ${stringLiteral(key)}: ${value}${index === bodyFields.length - 1 ? "" : ","}`
  )
  .join("\n")}
}`
}

function buildCheckAccessSdkExample(params?: SDKExampleParams) {
  return `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
${buildSdkClientOptions(params)}
})

// Check access before the paid action runs.
const { result, error } = await unprice.access.check({
  customerId: ${stringLiteral(getCustomerId(params))},
  featureSlug: "tokens",
})

if (error) {
  console.error(error.message)
  return
}

if (!result.allowed) {
  throw new Error("Denied before paid usage ran")
}
`
}

function buildCheckAccessFetchExample(params?: SDKExampleParams) {
  return `${buildFetchPreamble(params)}

await fetch(baseUrl + "/v1/access/check", {
  method: "POST",
  headers: {
    Authorization: ${getFetchAuthorization(params)},
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    customerId: ${stringLiteral(getCustomerId(params))},
    featureSlug: "tokens",
  }),
})`
}

function buildRecordUsageSdkExample(params?: SDKExampleParams) {
  const usage = getUsageExample(params)

  return `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
${buildSdkClientOptions(params)}
})

// Report usage asynchronously.
const { result, error } = await unprice.usage.record({
  idempotencyKey: crypto.randomUUID(),
  eventSlug: ${stringLiteral(usage.eventSlug)},
  customerId: ${stringLiteral(getCustomerId(params))},
  properties: ${buildUsagePropertiesObject(params, "    ")},
})

if (error) {
  console.error(error.message)
  return
}
`
}

function buildRecordUsageFetchExample(params?: SDKExampleParams) {
  const usage = getUsageExample(params)

  return `${buildFetchPreamble(params)}

await fetch(baseUrl + "/v1/usage/record", {
  method: "POST",
  headers: {
    Authorization: ${getFetchAuthorization(params)},
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    idempotencyKey: crypto.randomUUID(),
    eventSlug: ${stringLiteral(usage.eventSlug)},
    customerId: ${stringLiteral(getCustomerId(params))},
    properties: ${buildUsagePropertiesObject(params, "      ")},
  }),
})`
}

function buildConsumeUsageSdkExample(params?: SDKExampleParams) {
  const usage = getUsageExample(params)

  return `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
${buildSdkClientOptions(params)}
})

// Report usage synchronously when the request path needs a decision.
const { result, error } = await unprice.usage.consume({
  idempotencyKey: crypto.randomUUID(),
  eventSlug: ${stringLiteral(usage.eventSlug)},
  customerId: ${stringLiteral(getCustomerId(params))},
  featureSlug: ${stringLiteral(usage.featureSlug)},
  properties: ${buildUsagePropertiesObject(params, "    ")},
})

if (error) {
  console.error(error.message)
  return
}

if (!result.allowed) {
  throw new Error(result.message ?? "Usage denied")
}
`
}

function buildConsumeUsageFetchExample(params?: SDKExampleParams) {
  const usage = getUsageExample(params)

  return `${buildFetchPreamble(params)}

await fetch(baseUrl + "/v1/usage/consume", {
  method: "POST",
  headers: {
    Authorization: ${getFetchAuthorization(params)},
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    idempotencyKey: crypto.randomUUID(),
    eventSlug: ${stringLiteral(usage.eventSlug)},
    customerId: ${stringLiteral(getCustomerId(params))},
    featureSlug: ${stringLiteral(usage.featureSlug)},
    properties: ${buildUsagePropertiesObject(params, "      ")},
  }),
})`
}

function buildListPlanVersionsSdkExample(params: ListPlanVersionsExampleParams, apiToken?: string) {
  return `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
${buildSdkClientOptions({ apiToken })}
})

const { result, error } = await unprice.planVersions.list({
${buildPlanVersionsRequestLines(params)}
})

if (error) {
  console.error(error.message)
  return
}
${buildPlanVersionsContextComment(params)}const [planVersion] = result.planVersions
const featureSlugs =
  planVersion?.planFeatures.map((planFeature) => planFeature.feature.slug) ?? []
`
}

function buildListPlanVersionsFetchExample(
  params: ListPlanVersionsExampleParams,
  apiToken?: string
) {
  return `${buildFetchPreamble({ apiToken })}

const response = await fetch(baseUrl + "/v1/plan-versions/list", {
  method: "POST",
  headers: {
    Authorization: ${getFetchAuthorization({ apiToken })},
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
${buildPlanVersionsRequestLines(params, "    ")}
  }),
})

if (!response.ok) {
  throw new Error(await response.text())
}

const data = await response.json()
${buildPlanVersionsContextComment(params)}const [planVersion] = data.planVersions
const featureSlugs =
  planVersion?.planFeatures.map((planFeature) => planFeature.feature.slug) ?? []
`
}

function buildCurlPostCommand(path: string, body: string, params?: SDKExampleParams) {
  return `curl -sS "${API_BASE_URL}${path}" \\
  -H "Authorization: Bearer ${getCurlToken(params)}" \\
  -H "Content-Type: application/json" \\
  -d '${body}'
`
}

function buildCurlGetCommand(path: string, params?: SDKExampleParams) {
  return `curl -sS "${API_BASE_URL}${path}" \\
  -H "Authorization: Bearer ${getCurlToken(params)}"
`
}

function buildCheckAccessCurlExample(params?: SDKExampleParams) {
  return buildCurlPostCommand(
    "/v1/access/check",
    `{
  "customerId": ${stringLiteral(getCustomerId(params))},
  "featureSlug": "tokens"
}`,
    params
  )
}

function buildListPlanVersionsCurlExample(
  listParams: ListPlanVersionsExampleParams,
  params?: SDKExampleParams
) {
  return buildCurlPostCommand(
    "/v1/plan-versions/list",
    buildPlanVersionsJsonBody(listParams),
    params
  )
}

function buildCurlExample(currentMethod: method, params?: SDKExampleParams) {
  switch (currentMethod) {
    case "checkAccess":
      return buildCheckAccessCurlExample(params)
    case "recordUsage":
      if (params?.customerId || params?.usage || params?.apiToken) {
        const usage = getUsageExample(params)

        return buildCurlPostCommand(
          "/v1/usage/record",
          `{
  "idempotencyKey": "usage-example-1",
  "eventSlug": ${stringLiteral(usage.eventSlug)},
  "customerId": ${stringLiteral(getCustomerId(params))},
  "properties": ${buildUsagePropertiesJson(params, "    ")}
}`,
          params
        )
      }
      return buildCurlPostCommand(
        "/v1/usage/record",
        `{
  "idempotencyKey": "usage-example-1",
  "eventSlug": "tokens_used",
  "customerId": ${stringLiteral(getCustomerId(params))},
  "properties": {
    "tokens": 3842
  }
}`,
        params
      )
    case "consumeUsage":
      if (params?.customerId || params?.usage || params?.apiToken) {
        const usage = getUsageExample(params)

        return buildCurlPostCommand(
          "/v1/usage/consume",
          `{
  "idempotencyKey": "usage-example-1",
  "eventSlug": ${stringLiteral(usage.eventSlug)},
  "customerId": ${stringLiteral(getCustomerId(params))},
  "featureSlug": ${stringLiteral(usage.featureSlug)},
  "properties": ${buildUsagePropertiesJson(params, "    ")}
}`,
          params
        )
      }
      return buildCurlPostCommand(
        "/v1/usage/consume",
        `{
  "idempotencyKey": "usage-example-1",
  "eventSlug": "tokens_used",
  "customerId": ${stringLiteral(getCustomerId(params))},
  "featureSlug": "tokens",
  "properties": {
    "tokens": 3842
  }
}`,
        params
      )
    case "signUpCustomer":
      return buildCurlPostCommand(
        "/v1/customers/sign-up",
        `{
  "name": "Acme Inc.",
  "email": "billing@acme.test",
  "creditLinePolicy": "capped",
  "creditLineAmountMinor": 10000,
  "successUrl": "http://your-app.com/dashboard",
  "cancelUrl": "http://your-app.com/failed"
}`,
        params
      )
    case "listEntitlements":
      return buildCurlPostCommand(
        "/v1/access/entitlements/list",
        `{
  "customerId": ${stringLiteral(getCustomerId(params))}
}`,
        params
      )
    case "getWalletBalance":
      return buildCurlGetCommand(`/v1/wallet/balance?customerId=${getCustomerId(params)}`, params)
    case "getSubscription":
      return buildCurlPostCommand(
        "/v1/subscriptions/get",
        `{
  "customerId": ${stringLiteral(getCustomerId(params))}
}`,
        params
      )
    case "getUsage":
      return buildCurlPostCommand(
        "/v1/analytics/usage/get",
        `{
  "project_id": "project_1GTzSGrapiBW1QwCL3Fcn",
  "customer_id": ${stringLiteral(getCustomerId(params))},
  "range": "30d"
}`,
        params
      )
    case "getPaymentMethods":
      return buildCurlPostCommand(
        "/v1/payment-methods/list",
        `{
  "customerId": ${stringLiteral(getCustomerId(params))},
  "provider": "stripe"
}`,
        params
      )
    case "createPaymentMethod":
      return buildCurlPostCommand(
        "/v1/payment-methods/create",
        `{
  "paymentProvider": "stripe",
  "customerId": ${stringLiteral(getCustomerId(params))},
  "successUrl": "http://your-app.com/dashboard",
  "cancelUrl": "http://your-app.com/failed"
}`,
        params
      )
    case "listPlanVersions":
      return buildListPlanVersionsCurlExample(params?.listPlanVersions ?? {}, params)
    case "startBudgetedRun":
      return buildCurlPostCommand(
        "/v1/runs/start",
        `{
  "customerId": ${stringLiteral(getCustomerId(params))},
  "budgetAmountMinor": 5000,
  "idempotencyKey": "run-example-1",
  "workloadType": "workflow",
  "workloadId": "daily-report"
}`,
        params
      )
    case "applyRunUsage":
      return buildCurlPostCommand(
        "/v1/runs/consume/run_1GTzSGrapiBW1QwCL3Fcn",
        `{
  "featureSlug": "tokens",
  "eventSlug": "tokens_used",
  "idempotencyKey": "run-usage-example-1",
  "properties": {
    "tokens": 3842
  }
}`,
        params
      )
    case "endBudgetedRun":
      return buildCurlPostCommand(
        "/v1/runs/end/run_1GTzSGrapiBW1QwCL3Fcn",
        `{
  "status": "completed"
}`,
        params
      )
    case "explainCharge":
      return buildCurlPostCommand(
        "/v1/analytics/charges/explain",
        `{
  "invoice_id": "inv_1GTzSGrapiBW1QwCL3Fcn",
  "entry_id": "entry_1GTzSGrapiBW1QwCL3Fcn"
}`,
        params
      )
  }
}

function applyExampleParams(code: string, params?: SDKExampleParams) {
  let nextCode = code

  if (params?.customerId) {
    nextCode = nextCode.replaceAll(DEFAULT_CUSTOMER_ID, params.customerId)
  }

  if (params?.apiToken) {
    nextCode = nextCode
      .replaceAll('"Bearer " + token', stringLiteral(`Bearer ${params.apiToken}`))
      .replaceAll("const token = process.env.UNPRICE_TOKEN\n\n", "")
      .replaceAll("process.env.UNPRICE_TOKEN", stringLiteral(params.apiToken))
  }

  return nextCode
}

function getCodeExample(framework: Framework, currentMethod: method, params?: SDKExampleParams) {
  if (framework === "curl") {
    return buildCurlExample(currentMethod, params)
  }

  if (currentMethod === "checkAccess" && (params?.apiToken || params?.customerId)) {
    return framework === "sdk"
      ? buildCheckAccessSdkExample(params)
      : buildCheckAccessFetchExample(params)
  }

  if (
    currentMethod === "recordUsage" &&
    (params?.apiToken || params?.customerId || params?.usage)
  ) {
    return framework === "sdk"
      ? buildRecordUsageSdkExample(params)
      : buildRecordUsageFetchExample(params)
  }

  if (
    currentMethod === "consumeUsage" &&
    (params?.apiToken || params?.customerId || params?.usage)
  ) {
    return framework === "sdk"
      ? buildConsumeUsageSdkExample(params)
      : buildConsumeUsageFetchExample(params)
  }

  if (currentMethod === "listPlanVersions" && params?.listPlanVersions) {
    return framework === "sdk"
      ? buildListPlanVersionsSdkExample(params.listPlanVersions, params.apiToken)
      : buildListPlanVersionsFetchExample(params.listPlanVersions, params.apiToken)
  }

  return applyExampleParams(
    codeExamples[framework][currentMethod] ?? codeExamples.sdk.checkAccess,
    params
  )
}

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

  let methods = methodsProp ?? (Object.keys(codeExamples.sdk) as method[])

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
