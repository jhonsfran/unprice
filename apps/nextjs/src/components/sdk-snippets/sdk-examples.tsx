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
import { CodeEditor } from "../landing/code-editor"
import CopyToClipboard from "../landing/copy-to-clipboard"

const API_BASE_URL = API_DOMAIN.replace(/\/$/, "")

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type method =
  | "checkAccess"
  | "recordUsage"
  | "consumeUsage"
  | "signUpCustomer"
  | "listEntitlements"
  | "getWalletBalance"
  | "getSubscription"
  | "getUsage"
  | "getPaymentMethods"
  | "createPaymentMethod"
  | "listPlanVersions"
  | "startBudgetedRun"
  | "applyRunUsage"
  | "endBudgetedRun"
  | "explainCharge"

type Framework = "sdk" | "fetch" | "curl"

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

// ─────────────────────────────────────────────────────────────────────────────
// Param resolution
// ─────────────────────────────────────────────────────────────────────────────

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

function sdkToken(params?: SDKExampleParams) {
  return params?.apiToken ? JSON.stringify(params.apiToken) : "process.env.UNPRICE_TOKEN"
}

function fetchAuthorization(params?: SDKExampleParams) {
  return params?.apiToken ? JSON.stringify(`Bearer ${params.apiToken}`) : '"Bearer " + token'
}

function fetchPreamble(params?: SDKExampleParams) {
  return params?.apiToken
    ? `const baseUrl = ${JSON.stringify(API_BASE_URL)}`
    : `const baseUrl = ${JSON.stringify(API_BASE_URL)}
const token = process.env.UNPRICE_TOKEN`
}

function curlToken(params?: SDKExampleParams) {
  return params?.apiToken ?? "$UNPRICE_TOKEN"
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

// ─────────────────────────────────────────────────────────────────────────────
// Request-body model — one structured value, serialized per framework so the
// three tabs can never drift apart.
// ─────────────────────────────────────────────────────────────────────────────

type SnippetValue =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  // idempotency key: crypto.randomUUID() in code, a literal in cURL.
  | { t: "idem"; curl: string }
  | { t: "obj"; fields: SnippetField[] }
type SnippetField = { key: string; value: SnippetValue }

const field = (key: string, value: SnippetValue): SnippetField => ({ key, value })
const str = (v: string): SnippetValue => ({ t: "str", v })
const num = (v: number): SnippetValue => ({ t: "num", v })
const idem = (curl: string): SnippetValue => ({ t: "idem", curl })
const obj = (fields: SnippetField[]): SnippetValue => ({ t: "obj", fields })

// JS object literal (SDK call args + the object inside fetch's JSON.stringify):
// bare keys, trailing commas.
function jsObject(fields: SnippetField[], indent: string): string {
  if (fields.length === 0) return "{}"
  const inner = `${indent}  `
  const body = fields.map((f) => `${inner}${f.key}: ${jsValue(f.value, inner)},`).join("\n")
  return `{\n${body}\n${indent}}`
}
function jsValue(value: SnippetValue, indent: string): string {
  switch (value.t) {
    case "str":
      return JSON.stringify(value.v)
    case "num":
      return String(value.v)
    case "idem":
      return "crypto.randomUUID()"
    case "obj":
      return jsObject(value.fields, indent)
  }
}

// JSON body for cURL: quoted keys, no trailing commas.
function jsonObject(fields: SnippetField[], indent: string): string {
  if (fields.length === 0) return "{}"
  const inner = `${indent}  `
  const body = fields
    .map((f, i) => {
      const comma = i === fields.length - 1 ? "" : ","
      return `${inner}${JSON.stringify(f.key)}: ${jsonValue(f.value, inner)}${comma}`
    })
    .join("\n")
  return `{\n${body}\n${indent}}`
}
function jsonValue(value: SnippetValue, indent: string): string {
  switch (value.t) {
    case "str":
      return JSON.stringify(value.v)
    case "num":
      return String(value.v)
    case "idem":
      return JSON.stringify(value.curl)
    case "obj":
      return jsonObject(value.fields, indent)
  }
}

// Query string for GET requests (fetch/curl): key=value pairs, unquoted values.
function queryString(fields: SnippetField[]): string {
  const pairs = fields.map((f) => `${f.key}=${f.value.t === "str" ? f.value.v : ""}`)
  return pairs.length > 0 ? `?${pairs.join("&")}` : ""
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec table — one entry per method. `startBudgetedRun` and `listPlanVersions`
// are inherently irregular (a multi-call lifecycle / a param-driven body with a
// follow-up), so they render through dedicated builders below.
// ─────────────────────────────────────────────────────────────────────────────

type RegularMethod = Exclude<method, "startBudgetedRun" | "listPlanVersions">

type Spec = {
  sdkCall: string
  httpVerb: "GET" | "POST"
  path: string
  // Path parameter carried in the URL for fetch/curl (and as a leading SDK arg).
  pathParam?: { key: string; value: string }
  comment?: string
  body: (params?: SDKExampleParams) => SnippetField[]
  // Skip the `if (error) { … }` block (a couple of list calls omit it).
  showError?: boolean
  // Extra SDK code appended after the standard error block.
  sdkTail?: (params?: SDKExampleParams) => string
}

function usageBody(params: SDKExampleParams | undefined, withFeature: boolean): SnippetField[] {
  const usage = getUsageExample(params)
  const properties =
    usage.aggregationMethod === "count" || !usage.aggregationField
      ? obj([])
      : obj([field(usage.aggregationField, num(3842))])
  const fields = [
    field("idempotencyKey", idem("usage-example-1")),
    field("eventSlug", str(usage.eventSlug)),
    field("customerId", str(getCustomerId(params))),
  ]
  if (withFeature) fields.push(field("featureSlug", str(usage.featureSlug)))
  fields.push(field("properties", properties))
  return fields
}

const SPECS: Record<RegularMethod, Spec> = {
  checkAccess: {
    sdkCall: "access.check",
    httpVerb: "POST",
    path: "/v1/access/check",
    comment: "// Check access before the paid action runs.",
    body: (params) => [
      field("customerId", str(getCustomerId(params))),
      field("featureSlug", str("tokens")),
    ],
    sdkTail: () => '\nif (!result.allowed) {\n  throw new Error("Denied before paid usage ran")\n}\n',
  },
  recordUsage: {
    sdkCall: "usage.record",
    httpVerb: "POST",
    path: "/v1/usage/record",
    comment: "// Report usage asynchronously.",
    body: (params) => usageBody(params, false),
  },
  consumeUsage: {
    sdkCall: "usage.consume",
    httpVerb: "POST",
    path: "/v1/usage/consume",
    comment: "// Report usage synchronously when the request path needs a decision.",
    body: (params) => usageBody(params, true),
    sdkTail: () =>
      '\nif (!result.allowed) {\n  throw new Error(result.message ?? "Usage denied")\n}\n',
  },
  signUpCustomer: {
    sdkCall: "customers.signUp",
    httpVerb: "POST",
    path: "/v1/customers/sign-up",
    comment:
      "// One call provisions the customer, subscription,\n// entitlements, wallet, and billing period.\n// Omitting planVersionId uses the latest published version.",
    body: () => [
      field("name", str("Acme Inc.")),
      field("email", str("billing@acme.test")),
      field("creditLinePolicy", str("capped")),
      field("creditLineAmountMinor", num(10000)),
      field("successUrl", str("http://your-app.com/dashboard")),
      field("cancelUrl", str("http://your-app.com/failed")),
    ],
    sdkTail: () =>
      '\nconst customerId = result.customerId\n\n// Redirect to checkout when the plan requires payment.\nredirect(result.url ?? "/")\n',
  },
  listEntitlements: {
    sdkCall: "access.entitlements.list",
    httpVerb: "POST",
    path: "/v1/access/entitlements/list",
    body: (params) => [field("customerId", str(getCustomerId(params)))],
  },
  getWalletBalance: {
    sdkCall: "wallet.balance",
    httpVerb: "GET",
    path: "/v1/wallet/balance",
    body: (params) => [field("customerId", str(getCustomerId(params)))],
  },
  getSubscription: {
    sdkCall: "subscriptions.get",
    httpVerb: "POST",
    path: "/v1/subscriptions/get",
    body: (params) => [field("customerId", str(getCustomerId(params)))],
    sdkTail: () => "\nconsole.log(result)\n",
  },
  getUsage: {
    sdkCall: "analytics.usage.get",
    httpVerb: "POST",
    path: "/v1/analytics/usage/get",
    body: (params) => [
      field("project_id", str("project_1GTzSGrapiBW1QwCL3Fcn")),
      field("customer_id", str(getCustomerId(params))),
      field("range", str("30d")),
    ],
  },
  getPaymentMethods: {
    sdkCall: "paymentMethods.list",
    httpVerb: "POST",
    path: "/v1/payment-methods/list",
    showError: false,
    body: (params) => [
      field("customerId", str(getCustomerId(params))),
      field("provider", str("stripe")),
    ],
  },
  createPaymentMethod: {
    sdkCall: "paymentMethods.create",
    httpVerb: "POST",
    path: "/v1/payment-methods/create",
    showError: false,
    body: (params) => [
      field("paymentProvider", str("stripe")),
      field("customerId", str(getCustomerId(params))),
      field("successUrl", str("http://your-app.com/dashboard")),
      field("cancelUrl", str("http://your-app.com/failed")),
    ],
  },
  applyRunUsage: {
    sdkCall: "runs.consume",
    httpVerb: "POST",
    path: "/v1/runs/consume",
    pathParam: { key: "runId", value: "run_1GTzSGrapiBW1QwCL3Fcn" },
    comment: "// Apply usage to a running budgeted run.",
    body: () => [
      field("featureSlug", str("tokens")),
      field("eventSlug", str("tokens_used")),
      field("idempotencyKey", idem("run-usage-example-1")),
      field("properties", obj([field("tokens", num(3842))])),
    ],
    sdkTail: () => "\nif (!result.accepted) {\n  throw new Error(result.reason)\n}\n",
  },
  endBudgetedRun: {
    sdkCall: "runs.end",
    httpVerb: "POST",
    path: "/v1/runs/end",
    pathParam: { key: "runId", value: "run_1GTzSGrapiBW1QwCL3Fcn" },
    comment: "// End a budgeted run and release unused reservation funds.",
    body: () => [field("status", str("completed"))],
  },
  explainCharge: {
    sdkCall: "analytics.charges.explain",
    httpVerb: "POST",
    path: "/v1/analytics/charges/explain",
    comment: "// Explain an invoice charge from rated usage and ledger evidence.",
    body: () => [
      field("invoice_id", str("inv_1GTzSGrapiBW1QwCL3Fcn")),
      field("entry_id", str("entry_1GTzSGrapiBW1QwCL3Fcn")),
    ],
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderers — three per-framework functions that wrap one spec's body.
// ─────────────────────────────────────────────────────────────────────────────

function sdkArgs(spec: Spec, params?: SDKExampleParams): SnippetField[] {
  const leading = spec.pathParam ? [field(spec.pathParam.key, str(spec.pathParam.value))] : []
  return [...leading, ...spec.body(params)]
}

function renderSdk(spec: Spec, params?: SDKExampleParams): string {
  const lines = [
    'import { Unprice } from "@unprice/api"',
    "",
    "const unprice = new Unprice({",
    `  token: ${sdkToken(params)},`,
    `  baseUrl: ${JSON.stringify(API_BASE_URL)},`,
    "})",
    "",
  ]
  if (spec.comment) lines.push(spec.comment)
  lines.push(`const { result, error } = await unprice.${spec.sdkCall}(${jsObject(sdkArgs(spec, params), "")})`)
  if (spec.showError !== false) {
    lines.push("", "if (error) {", "  console.error(error.message)", "  return", "}")
  }
  let code = `${lines.join("\n")}\n`
  if (spec.sdkTail) code += spec.sdkTail(params)
  return code
}

function fetchUrl(spec: Spec, params?: SDKExampleParams): string {
  const pathWithParam = spec.pathParam ? `${spec.path}/${spec.pathParam.value}` : spec.path
  const query = spec.httpVerb === "GET" ? queryString(spec.body(params)) : ""
  return `${pathWithParam}${query}`
}

function renderFetch(spec: Spec, params?: SDKExampleParams): string {
  const header = `  headers: {
    Authorization: ${fetchAuthorization(params)},
    "Content-Type": "application/json",
  },`

  if (spec.httpVerb === "GET") {
    return `${fetchPreamble(params)}

await fetch(baseUrl + ${JSON.stringify(fetchUrl(spec, params))}, {
  method: "GET",
${header}
})`
  }

  return `${fetchPreamble(params)}

await fetch(baseUrl + ${JSON.stringify(fetchUrl(spec, params))}, {
  method: "POST",
${header}
  body: JSON.stringify(${jsObject(spec.body(params), "  ")}),
})`
}

function curlPost(path: string, body: string, params?: SDKExampleParams) {
  return `curl -sS "${API_BASE_URL}${path}" \\
  -H "Authorization: Bearer ${curlToken(params)}" \\
  -H "Content-Type: application/json" \\
  -d '${body}'
`
}

function curlGet(path: string, params?: SDKExampleParams) {
  return `curl -sS "${API_BASE_URL}${path}" \\
  -H "Authorization: Bearer ${curlToken(params)}"
`
}

function renderCurl(spec: Spec, params?: SDKExampleParams): string {
  const pathWithParam = spec.pathParam ? `${spec.path}/${spec.pathParam.value}` : spec.path
  if (spec.httpVerb === "GET") {
    return curlGet(`${pathWithParam}${queryString(spec.body(params))}`, params)
  }
  return curlPost(pathWithParam, jsonObject(spec.body(params), ""), params)
}

// ─────────────────────────────────────────────────────────────────────────────
// Irregular methods
// ─────────────────────────────────────────────────────────────────────────────

function planVersionsRequestLines(params: ListPlanVersionsExampleParams, indent = "  ") {
  const lines: string[] = []
  if (params.planVersionIds && params.planVersionIds.length > 0) {
    lines.push(`${indent}planVersionIds: [${params.planVersionIds.map((v) => JSON.stringify(v)).join(", ")}],`)
  }
  if (params.billingInterval) {
    lines.push(`${indent}billingInterval: ${JSON.stringify(params.billingInterval)},`)
  }
  if (params.currency) {
    lines.push(`${indent}currency: ${JSON.stringify(params.currency)},`)
  }
  return lines.length > 0
    ? lines.join("\n")
    : `${indent}billingInterval: "month",\n${indent}currency: "USD",`
}

function planVersionsContextComment(params: ListPlanVersionsExampleParams) {
  const context: string[] = []
  if (params.version !== undefined) context.push(`v${params.version}`)
  if (params.featureSlugs && params.featureSlugs.length > 0) {
    context.push(`features: ${params.featureSlugs.map((v) => JSON.stringify(v)).join(", ")}`)
  }
  return context.length > 0 ? `\n// Dashboard context: ${context.join("; ")}\n` : "\n"
}

function planVersionsJsonBody(params: ListPlanVersionsExampleParams) {
  const lines: string[] = []
  if (params.planVersionIds && params.planVersionIds.length > 0) {
    lines.push(`  "planVersionIds": [${params.planVersionIds.map((v) => JSON.stringify(v)).join(", ")}]`)
  }
  if (params.billingInterval) lines.push(`  "billingInterval": ${JSON.stringify(params.billingInterval)}`)
  if (params.currency) lines.push(`  "currency": ${JSON.stringify(params.currency)}`)
  const bodyLines = lines.length > 0 ? lines : ['  "billingInterval": "month"', '  "currency": "USD"']
  return `{\n${bodyLines.join(",\n")}\n}`
}

function renderListPlanVersions(framework: Framework, params?: SDKExampleParams): string {
  const listParams = params?.listPlanVersions ?? {}

  if (framework === "curl") {
    return curlPost("/v1/plan-versions/list", planVersionsJsonBody(listParams), params)
  }

  if (framework === "sdk") {
    return `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: ${sdkToken(params)},
  baseUrl: ${JSON.stringify(API_BASE_URL)},
})

const { result, error } = await unprice.planVersions.list({
${planVersionsRequestLines(listParams)}
})

if (error) {
  console.error(error.message)
  return
}
${planVersionsContextComment(listParams)}const [planVersion] = result.planVersions
const featureSlugs =
  planVersion?.planFeatures.map((planFeature) => planFeature.feature.slug) ?? []
`
  }

  return `${fetchPreamble(params)}

const response = await fetch(baseUrl + "/v1/plan-versions/list", {
  method: "POST",
  headers: {
    Authorization: ${fetchAuthorization(params)},
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
${planVersionsRequestLines(listParams, "    ")}
  }),
})

if (!response.ok) {
  throw new Error(await response.text())
}

const data = await response.json()
${planVersionsContextComment(listParams)}const [planVersion] = data.planVersions
const featureSlugs =
  planVersion?.planFeatures.map((planFeature) => planFeature.feature.slug) ?? []
`
}

function renderStartBudgetedRun(framework: Framework, params?: SDKExampleParams): string {
  const customerId = getCustomerId(params)

  if (framework === "curl") {
    return curlPost(
      "/v1/runs/start",
      `{
  "customerId": ${JSON.stringify(customerId)},
  "budgetAmountMinor": 5000,
  "idempotencyKey": "run-example-1",
  "workloadType": "workflow",
  "workloadId": "daily-report"
}`,
      params
    )
  }

  if (framework === "sdk") {
    return `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: ${sdkToken(params)},
  baseUrl: ${JSON.stringify(API_BASE_URL)},
})

// Start a budgeted run before the workload creates cost,
// then consume usage and end the run.
const { result: run, error: startError } = await unprice.runs.start({
  customerId: ${JSON.stringify(customerId)},
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
`
  }

  return `${fetchPreamble(params)}

const startResponse = await fetch(baseUrl + "/v1/runs/start", {
  method: "POST",
  headers: {
    Authorization: ${fetchAuthorization(params)},
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    customerId: ${JSON.stringify(customerId)},
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
      Authorization: ${fetchAuthorization(params)},
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
      Authorization: ${fetchAuthorization(params)},
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      status: finalStatus,
    }),
  })
}`
}

function getCodeExample(framework: Framework, currentMethod: method, params?: SDKExampleParams) {
  if (currentMethod === "startBudgetedRun") return renderStartBudgetedRun(framework, params)
  if (currentMethod === "listPlanVersions") return renderListPlanVersions(framework, params)

  const spec = SPECS[currentMethod]
  if (framework === "sdk") return renderSdk(spec, params)
  if (framework === "fetch") return renderFetch(spec, params)
  return renderCurl(spec, params)
}

// ─────────────────────────────────────────────────────────────────────────────
// Display metadata
// ─────────────────────────────────────────────────────────────────────────────

const METHOD_ORDER: method[] = [
  "checkAccess",
  "recordUsage",
  "consumeUsage",
  "signUpCustomer",
  "listEntitlements",
  "getWalletBalance",
  "getSubscription",
  "getUsage",
  "getPaymentMethods",
  "createPaymentMethod",
  "listPlanVersions",
  "startBudgetedRun",
  "applyRunUsage",
  "endBudgetedRun",
  "explainCharge",
]

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
