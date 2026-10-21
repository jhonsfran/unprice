# Shared AI budget enforcement

`@unprice/budgets-ai` is the request boundary the Pi and AI SDK integrations share. It depends on `@unprice/budgets` and web APIs. It has no model SDK dependency.

Most applications should install `@unprice/ai-sdk-budget` or `@unprice/pi-budget` instead. Use this package directly when building another integration.

```ts
import { createBudgetSession } from "@unprice/budgets-ai"

const call = createBudgetSession({
  getBudget: () => unprice.budget(customerKey),
  protocol: "openai-responses", // or "anthropic-messages", "google-generative-ai"
  model: { id: modelId, pricing, limits }, // the catalog row: rates per million tokens, context and output limits
  maxOutputTokens: 4096,
  mode: "generate", // use "stream" for SSE
})
const response = await call.fetch(request)
// Read the provider result before settlement.
const settled = await call.settle(actualCost) // omit when usage is unknown
```

A session permits one physical generation request. Its fetch validates the final serialized body, keeps the smaller of the caller's and the model's output limits, bounds the input tokens by the body's bytes, and obtains a five-minute hold before dispatch. Each retry or fallback that can incur cost requires a fresh session. Unsupported routes and billable features fail before authorization.

The hold is `(inputBound(body, messages) + TOOL_PROMPT_TOKENS[protocol]) × highest input rate + output limit × output rate`, rounded up at eight decimals. `inputBound` is the UTF-8 length of the body plus 8 tokens per message and 32 per request: byte-level BPE and byte-fallback SentencePiece tokenizers emit at least one byte per token, so the request's tokens never exceed it. `TOOL_PROMPT_TOKENS` reserves what a provider adds outside the body when the request carries tools: 1024 for Anthropic's hidden tool-use system prompt (264 to 804 tokens by model, per its docs), 0 for the others. No count request goes to the provider. `session.reserved` exposes the bound and the hold once authorized, and `settle` resolves with the step's settlement: the hold, the actual cost, the remaining balance, and `exceeded`. When the actual cost exceeds the hold, the session records the excess first under `<authorizationKey>:excess`, then settles the hold in full. Both operations retain their original inputs for replay. This also supports local holds, which exist only in client memory.

Supported protocols are `openai-responses` (the default), `anthropic-messages`, and `google-generative-ai`. All require explicit text transcripts and local function tools. Media, hosted tools, model fallbacks, explicit Gemini caches, and resumable operations are rejected before authorization. Standard service tiers and bounded output include thinking tokens.

Anthropic supports automatic and explicit 5-minute prompt caching. One-hour cache writes require a different price and are rejected. If inference geography is omitted, rates must match the workspace default. Explicit geography and speed requests are forced to global and standard. Gemini uses Developer API generateContent routes, one text candidate, and a maximum of 32768 output tokens for generation or 65536 for streaming. Vertex, Interactions, and continuations are rejected. Native SDK integrations must preserve the JSON or SSE parser mode when applying payload transforms.

The budget must use USD. `pricing` is USD per million tokens, `{ input, output, cacheRead, cacheWrite, tiers? }`, as `unprice.model("provider/model")` serves it; tiers carry `inputTokensAbove`. `usageCost` expects uncached input separately from cache tokens and output including reasoning once. Pi can instead settle its reported USD cost.

The provider call has a two-minute deadline. Budget resolution, authorization, and settlement each use a bounded operation deadline, default ten seconds. Final settlement continues after caller cancellation. Unknown usage consumes the full reservation. Never release a hold after work that may have incurred cost. Settlement keeps its first amount. Failed attempts can be retried; successful attempts keep their result. A reported cost above the hold uses a fixed excess record and a settlement within the hold. The record keeps the same event time and idempotency key on every attempt.

A failed attempt throws `BudgetSettleError`. Its `retry()` completes the original intent; `recovery` contains the exact hold settlement amount and optional excess record. Persist the hold identity and recovery data before returning when recovery must survive process loss. For a remote hold, replay the record before settling the hold. Local holds cannot be restored after process loss; replay any excess record and let the server lease expire.

A process crash can leave an open hold, which counts in full at expiry. The adapter cannot recover a provider response lost before usage was recorded. Applications remain responsible for identity, provisioning, credentials, and paid external tools.
