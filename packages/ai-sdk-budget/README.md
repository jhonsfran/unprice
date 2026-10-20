# @unprice/ai-sdk-budget

Apply an Unprice budget to AI SDK model calls. This package supports text and local function tools
through OpenAI Responses, Anthropic Messages, and Gemini GenerateContent. It uses
`@unprice/budgets` for authorization and settlement.

```ts
import { createOpenAI } from "@ai-sdk/openai"
import { createUnpriceBudgetMiddleware } from "@unprice/ai-sdk-budget"
import { Unprice } from "@unprice/budgets"
import { generateText, wrapLanguageModel } from "ai"

const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN! })
const budget = createUnpriceBudgetMiddleware({
  getBudget: () => unprice.budget("customer:acme"),
  getPricing: (modelId) => prices[modelId],
  maxOutputTokens: 4096,
})
const openai = createOpenAI({ fetch: budget.fetch })
const model = wrapLanguageModel({
  model: openai.responses(modelId),
  middleware: budget.middleware,
})

const result = await generateText({ model, prompt, maxRetries: 0 })
```

Define `prices`, `modelId`, and `prompt` in your application. Pricing uses USD per million tokens:
`{ input, output, cacheRead, cacheWrite, tiers? }`. Supply all applicable pricing tiers. The maximum
rate across tiers bounds the hold. Keep pricing current for the model and your provider account.

Use both returned values. The middleware identifies each model call, and the paired fetch checks
the final serialized request before it reaches the provider. A missing or mismatched middleware blocks
the request. The adapter removes its internal header before the count and generation requests.

`generateText` and `streamText` use the same wrapped model. Each generation dispatch has a separate
hold, including SDK retries and tool-loop steps. Set `maxRetries: 0` to avoid paid retries after
uncertain provider failures. Stream retries also make new paid attempts.

The adapter permits one generation dispatch per middleware call. It clamps the output limit,
counts the final input for OpenAI, and rejects unsupported request fields and provider tools.
It preserves the provider's JSON or streaming response mode. Local tool execution costs need
their own budget integration.

Generation returns only after settlement. Streaming text can arrive before settlement, but the
final `finish` event waits for settlement. Provider error events also wait for settlement.
The adapter reads only when the consumer requests data. Cancellation, an abandoned stream's
deadline, missing usage, or an incomplete stream settles the full authorized amount. A settlement failure
propagates and does not release the hold. Settlement above the authorized amount fails.

In Cloudflare Workers, pass `waitUntil: (work) => ctx.waitUntil(work)` to preserve this work after
disconnects. Each call has a 120-second deadline. `budgetTimeoutMs` sets the authorization and
settlement deadline, with a default of 10 seconds. The default output limit is 4096 tokens;
configured limits must be safe integers of at least 16.

For Anthropic or Gemini, select the protocol and provide trusted model limits. The resolver must
return the provider's maximum accepted input and output token counts for that model.

```ts
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogle } from "@ai-sdk/google"

const anthropicBudget = createUnpriceBudgetMiddleware({
  protocol: "anthropic-messages",
  getBudget: () => unprice.budget("customer:acme"),
  getPricing: resolveAnthropicPricing,
  getModelLimits: resolveAnthropicLimits,
})
const anthropic = createAnthropic({ fetch: anthropicBudget.fetch })
const claude = wrapLanguageModel({
  model: anthropic.messages(claudeModelId),
  middleware: anthropicBudget.middleware,
})

const googleBudget = createUnpriceBudgetMiddleware({
  protocol: "google-generative-ai",
  getBudget: () => unprice.budget("customer:acme"),
  getPricing: resolveGooglePricing,
  getModelLimits: resolveGoogleLimits,
})
const google = createGoogle({ fetch: googleBudget.fetch })
const gemini = wrapLanguageModel({
  model: google.chat(geminiModelId),
  middleware: googleBudget.middleware,
})
```

Each limit resolver returns `{ maxInputTokens, maxOutputTokens }`. The adapter validates and
copies these values for each call. It clamps the native output parameter before the provider
serializes the request. The shared policy checks the final request again.

Anthropic and Gemini token-count APIs provide estimates. These protocols reserve the full trusted
input limit plus the bounded output cost. They make no count request. This holds more budget than
a typical call consumes, but it gives concurrent calls a hard bound. Final usage releases the
unused amount. OpenAI keeps its exact input-count preflight; its protocol remains the default.

Anthropic supports default or explicit five-minute cache writes. Set `cacheWrite` to that rate.
One-hour cache writes, hosted tools, compaction, and server-side fallback operations are rejected.
Gemini supports implicit cache reads. Explicit cache resources, hosted tools, media, and
Interactions requests are rejected. Output usage already includes reasoning tokens in both
providers; the adapter counts them once.

For Anthropic and Gemini streams, a native SDK `finish` event alone does not prove final usage.
The adapter checks raw provider completion events internally. Missing terminal usage, early usage
followed by more content, or an unknown Anthropic completion settles the full hold. Internal raw
events remain hidden unless the caller requested raw chunks.

Requires AI SDK 7 and its V4 model contract. Provider instances that bypass the paired fetch,
hidden transport retries, and custom gateways need a separate integration.
