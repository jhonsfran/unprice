# Shared AI budget enforcement

`@unprice/budgets-ai` provides the request boundary used by the Pi and AI SDK integrations. It depends on `@unprice/budgets` and web APIs. It has no model SDK dependency.

Most applications should install `@unprice/pi-budget` or `@unprice/ai-sdk-budget` instead. Use this package directly when building another integration.

```ts
import { createBudgetSession } from "@unprice/budgets-ai"

const call = createBudgetSession({
  getBudget: () => unprice.budget(customerKey),
  modelId,
  pricing, // USD per million input, output, cacheRead, cacheWrite tokens
  maxOutputTokens: 4096,
  mode: "generate", // use "stream" for SSE
})
const response = await call.fetch(request)
// Read the provider result before settlement.
await call.settle(actualCost) // omit when usage is unknown
```

A session permits one physical generation request. Its fetch validates the final serialized body, preserves a smaller output cap, establishes an input cost bound, and obtains a five-minute hold before dispatch. Each retry or fallback that can incur cost requires a fresh session. Unsupported routes and billable features fail before generation.

Supported protocols are `openai-responses` (the default), `anthropic-messages`, and `google-generative-ai`. All require explicit text transcripts and local function tools. Media, hosted tools, model fallbacks, explicit Gemini caches, and resumable operations are rejected before authorization. Standard service tiers and bounded output include thinking tokens.

OpenAI counts the final request through `/responses/input_tokens`, adding one HTTP request. Anthropic and Gemini count APIs provide estimates, so they cannot establish a hard cost bound. Those protocols instead require trusted `modelLimits: { maxInputTokens, maxOutputTokens }` and reserve the full input allowance plus bounded output. No count request is sent. The allowance must match the actual provider model and endpoint. This can make holds much larger than the eventual charge. See the official [Anthropic counting guide](https://platform.claude.com/docs/en/build-with-claude/token-counting) and [Gemini token API](https://ai.google.dev/api/tokens).

Anthropic supports automatic and explicit 5-minute prompt caching. One-hour cache writes require a different price and are rejected. If inference geography is omitted, rates must match the workspace default. Explicit geography and speed requests are forced to global and standard. Gemini uses Developer API generateContent routes, one text candidate, and a maximum of 32768 output tokens for generation or 65536 for streaming. Vertex, Interactions, and continuations are rejected. Native SDK integrations must preserve the JSON or SSE parser mode when applying payload transforms.

The budget must use USD. Pricing comes from the integration or application and must match the endpoint and model. Rates may include whole-request tiers with `inputTokensAbove`. `usageCost` expects uncached input separately from cache tokens and output including reasoning once. Pi can instead settle its reported USD cost.

The provider call has a two-minute deadline. Budget resolution, authorization, and settlement each use a bounded operation deadline, default ten seconds. Final settlement continues after caller cancellation. Unknown usage consumes the full reservation. Never release a hold after work that may have incurred cost. A valid reported cost above the hold is sent unchanged for reconciliation; the budget server rejects it without releasing the reservation. Repeated settlement uses the first amount and result.

A process crash can leave an open hold, which counts in full at expiry. The adapter cannot recover a provider response lost before usage was recorded. Applications remain responsible for identity, provisioning, credentials, and paid external tools.
