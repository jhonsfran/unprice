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

A session permits one physical generation request. Its fetch validates the final serialized body, keeps the smaller of the caller's and the model's output limits, bounds the input tokens by the body's bytes, and obtains a five-minute hold before dispatch. If that reservation is denied, the session can refine the input count and reduce the output allowance before it requests another hold. Each retry or fallback that can incur cost requires a fresh session. Unsupported routes and billable features fail before authorization.

The hold is `input tokens × highest reachable input rate + output allowance × highest reachable output rate`, rounded up at eight decimals. Pricing includes the base rates and context tiers below the input upper bound. A tier whose threshold equals or exceeds that bound cannot apply. Input pricing covers uncached input, cache reads, and cache writes.

The initial input bound is the UTF-8 length of the final body plus 8 tokens per message and 32 per request. `TOOL_PROMPT_TOKENS` adds 1024 tokens for Anthropic requests with tools. This covers the provider's hidden tool-use prompt, which its documentation lists as 264 to 804 tokens by model. Other protocols add no tool prompt reserve.

A funded request sends no count request. After a definite limit denial, OpenAI Responses can use one [input-token count](https://developers.openai.com/api/docs/guides/token-counting) from the same endpoint and immutable input. If counting fails, the byte bound remains in force. Anthropic and Gemini counts are estimates, so admission retains their byte bounds. The session chooses the largest legal output allowance that fits, then authorizes the revised amount. It allows at most three authorization attempts and never retries a paid generation automatically. Every revised request still needs an atomic authorization. A stale balance cannot authorize work.

The output setting is a ceiling. Low funds can produce a shorter or truncated answer. The SDK preserves thinking settings and protocol output minima. Anthropic enabled thinking needs at least 1025 output tokens. Input, model, tools, service tier, and JSON versus SSE mode stay fixed during adaptation.

`session.reserved` exposes `inputTokens`, `inputSource`, `requestedOutputTokens`, `outputTokens`, and the hold once authorized. `inputSource` is `byte-bound` or `provider-count`. `settle` resolves with the hold, actual cost, remaining balance, and `exceeded`. When actual cost exceeds the hold, the session records the excess first under `<authorizationKey>:excess`, then settles the hold in full. Both operations retain their original inputs for replay. Local handles supply their immediate lease capacity without changing the global balance snapshot. An empty local lease can still refill. `session.exhausted(remaining)` uses a conservative output-only lower bound for the current model. It does not predict the next request's input cost or declare an empty local lease exhausted.

Supported protocols are `openai-responses` (the default), `anthropic-messages`, and `google-generative-ai`. All require explicit text transcripts and local function tools. Media, hosted tools, model fallbacks, explicit Gemini caches, and resumable operations are rejected before authorization. Standard service tiers and bounded output include thinking tokens.

Anthropic supports automatic and explicit 5-minute prompt caching. One-hour cache writes require a different price and are rejected. If inference geography is omitted, rates must match the workspace default. Explicit geography and speed requests are forced to global and standard. Gemini uses Developer API generateContent routes, one text candidate, and a maximum of 32768 output tokens for generation or 65536 for streaming. Vertex, Interactions, and continuations are rejected. Native SDK integrations must preserve the JSON or SSE parser mode when applying payload transforms.

The budget must use USD. `pricing` is USD per million tokens, `{ input, output, cacheRead, cacheWrite, tiers? }`, as `unprice.model("provider/model")` serves it; tiers carry `inputTokensAbove`. `usageCost` expects uncached input separately from cache tokens and output including reasoning once. Pi can instead settle its reported USD cost.

The provider call has a two-minute deadline. Budget resolution, count refinement, and authorization share a bounded admission deadline, default ten seconds. Settlement has its own deadline and continues after caller cancellation. Unknown usage consumes the full reservation. Never release a hold after work that may have incurred cost. Settlement keeps its first amount. Failed attempts can be retried; successful attempts keep their result. A reported cost above the hold uses a fixed excess record and a settlement within the hold. The record keeps the same event time and idempotency key on every attempt.

A failed attempt throws `BudgetSettleError`. Its `retry()` completes the original intent; `recovery` contains the exact hold settlement amount and optional excess record. Persist the hold identity and recovery data before returning when recovery must survive process loss. For a remote hold, replay the record before settling the hold. Local holds cannot be restored after process loss; replay any excess record and let the server lease expire.

A process crash can leave an open hold, which counts in full at expiry. The adapter cannot recover a provider response lost before usage was recorded. Applications remain responsible for identity, provisioning, credentials, and paid external tools.
