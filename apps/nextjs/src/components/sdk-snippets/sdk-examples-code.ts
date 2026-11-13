import { API_DOMAIN } from "@unprice/config"

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
  | "explainCharge"

export type Framework = "sdk" | "fetch" | "curl"

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
    aggregationMethod?: "count" | "sum"
    aggregationField?: string | null
  }
}

const DEFAULT_CUSTOMER_ID = "cus_1GTzSGrapiBW1QwCL3Fcn"
const DEFAULT_USAGE_EVENT_SLUG = "tokens_used"
const DEFAULT_USAGE_FEATURE_SLUG = "tokens"
const DEFAULT_USAGE_AGGREGATION_FIELD = "tokens"
export const DEFAULT_FRAMEWORKS = ["sdk", "fetch"] satisfies Framework[]

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
  return params?.apiToken ? JSON.stringify(params.apiToken) : "process.env.UNPRICE_TOKEN!"
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

export function getDisplayCode(code: string, params?: SDKExampleParams) {
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
  | { t: "now" }
  | { t: "array"; items: SnippetValue[]; inline?: boolean }
  | { t: "obj"; fields: SnippetField[] }
type SnippetField = { key: string; value: SnippetValue }

const field = (key: string, value: SnippetValue): SnippetField => ({ key, value })
const str = (v: string): SnippetValue => ({ t: "str", v })
const num = (v: number): SnippetValue => ({ t: "num", v })
const idem = (curl: string): SnippetValue => ({ t: "idem", curl })
const obj = (fields: SnippetField[]): SnippetValue => ({ t: "obj", fields })
const array = (items: SnippetValue[], inline = false): SnippetValue => ({
  t: "array",
  items,
  inline,
})

// JS object literal (SDK call args + the object inside fetch's JSON.stringify):
// bare keys, trailing commas.
function jsObject(fields: SnippetField[], indent: string): string {
  if (fields.length === 0) return "{}"
  const inner = `${indent}  `
  const body = fields
    .map((f) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(f.key) ? f.key : JSON.stringify(f.key)
      return `${inner}${key}: ${jsValue(f.value, inner)},`
    })
    .join("\n")
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
    case "now":
      return "Date.now()"
    case "array":
      if (value.inline) return `[${value.items.map((item) => jsValue(item, indent)).join(", ")}]`
      return `[\n${value.items.map((item) => `${indent}  ${jsValue(item, `${indent}  `)},`).join("\n")}\n${indent}]`
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
    case "now":
      return "'\"$(date +%s)000\"'"
    case "array":
      if (value.inline) return `[${value.items.map((item) => jsonValue(item, indent)).join(", ")}]`
      return `[\n${value.items.map((item) => `${indent}  ${jsonValue(item, `${indent}  `)}`).join(",\n")}\n${indent}]`
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
// Spec table — one entry per method.
// ─────────────────────────────────────────────────────────────────────────────

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
  // Success handling shared by SDK and fetch examples.
  successCode?: (params: SDKExampleParams | undefined, resultName: string) => string
  fetchResult?: string
}

function usageBody(params: SDKExampleParams | undefined): SnippetField[] {
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
  fields.push(field("properties", properties))
  return fields
}

const SPECS: Record<method, Spec> = {
  checkAccess: {
    sdkCall: "access.check",
    httpVerb: "POST",
    path: "/v1/access/check",
    comment: "// Check access before the paid action runs.",
    body: (params) => [
      field("customerId", str(getCustomerId(params))),
      field("featureSlug", str(getUsageExample(params).featureSlug)),
    ],
    successCode: () =>
      '\nif (!result.allowed) {\n  throw new Error("Denied before paid usage ran")\n}\n',
  },
  recordUsage: {
    sdkCall: "usage.record",
    httpVerb: "POST",
    path: "/v1/usage/record",
    comment: "// Record completed usage. Keep the event's time and key when retrying.",
    body: (params) => [
      field("events", array([obj([...usageBody(params), field("occurredAt", { t: "now" })])])),
    ],
    successCode: () =>
      '\nfor (const event of result.results) {\n  if (event.status === "rejected") {\n    throw new Error(`${event.error.reason}: ${event.error.message}`)\n  }\n}\n',
  },
  consumeUsage: {
    sdkCall: "usage.consume",
    httpVerb: "POST",
    path: "/v1/usage/consume",
    comment: "// Admit known usage before paid work. A commercial denial returns a 402 error.",
    body: (params) => usageBody(params),
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
    successCode: () =>
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
    successCode: () => "\nconsole.log(result)\n",
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
  listPlanVersions: {
    sdkCall: "planVersions.list",
    httpVerb: "POST",
    path: "/v1/plan-versions/list",
    fetchResult: "data",
    body: (params) => {
      const list = params?.listPlanVersions ?? {}
      const fields: SnippetField[] = []
      if (list.planVersionIds?.length) {
        fields.push(field("planVersionIds", array(list.planVersionIds.map(str), true)))
      }
      if (list.billingInterval) fields.push(field("billingInterval", str(list.billingInterval)))
      if (list.currency) fields.push(field("currency", str(list.currency)))
      return fields.length
        ? fields
        : [field("billingInterval", str("month")), field("currency", str("USD"))]
    },
    successCode: (
      params,
      resultName
    ) => `${planVersionsContextComment(params?.listPlanVersions ?? {})}const [planVersion] = ${resultName}.planVersions
const featureSlugs =
  planVersion?.planFeatures.map((planFeature) => planFeature.feature.slug) ?? []
`,
  },
  explainCharge: {
    sdkCall: "analytics.charges.explain",
    httpVerb: "POST",
    path: "/v1/analytics/charges/explain",
    comment: "// Explain an invoice charge from journal events and ledger evidence.",
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
  lines.push(
    `const { result, error } = await unprice.${spec.sdkCall}(${jsObject(sdkArgs(spec, params), "")})`
  )
  if (spec.showError !== false) {
    lines.push("", "if (error) {", "  console.error(error.message)", "  return", "}")
  }
  let code = `${lines.join("\n")}\n`
  if (spec.successCode) code += spec.successCode(params, "result")
  return code
}

function fetchUrl(spec: Spec, params?: SDKExampleParams): string {
  const pathWithParam = spec.pathParam ? `${spec.path}/${spec.pathParam.value}` : spec.path
  const query = spec.httpVerb === "GET" ? queryString(spec.body(params)) : ""
  return `${pathWithParam}${query}`
}

function renderFetch(spec: Spec, params?: SDKExampleParams): string {
  const body =
    spec.httpVerb === "POST"
      ? `\n  body: JSON.stringify(${jsObject(spec.body(params), "  ")}),`
      : ""
  return `${fetchPreamble(params)}

${spec.comment ? `${spec.comment}\n` : ""}const response = await fetch(baseUrl + ${JSON.stringify(fetchUrl(spec, params))}, {
  method: "${spec.httpVerb}",
  headers: {
    Authorization: ${fetchAuthorization(params)},
    "Content-Type": "application/json",
  },${body}
})

if (!response.ok) {
  throw new Error(await response.text())
}

const ${spec.fetchResult ?? "result"} = await response.json()
${spec.successCode?.(params, spec.fetchResult ?? "result") ?? ""}`
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

function planVersionsContextComment(params: ListPlanVersionsExampleParams) {
  const context: string[] = []
  if (params.version !== undefined) context.push(`v${params.version}`)
  if (params.featureSlugs && params.featureSlugs.length > 0) {
    context.push(`features: ${params.featureSlugs.map((v) => JSON.stringify(v)).join(", ")}`)
  }
  return context.length > 0 ? `\n// Dashboard context: ${context.join("; ")}\n` : "\n"
}

export function getCodeExample(
  framework: Framework,
  currentMethod: method,
  params?: SDKExampleParams
) {
  const spec = SPECS[currentMethod]
  if (framework === "sdk") return renderSdk(spec, params)
  if (framework === "fetch") return renderFetch(spec, params)
  return renderCurl(spec, params)
}

export const METHOD_ORDER: method[] = [
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
  "explainCharge",
]
