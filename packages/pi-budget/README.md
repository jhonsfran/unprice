# Unprice budgets for Pi

This package provides `withUnpriceBudget` and `withUnpriceTool`.
`withUnpriceBudget` wraps a Pi AI provider before registration with `createModels`.
The same provider handles Pi
Durable generation, tool loops, child conversations, and compaction.

Install `@unprice/pi-budget` with Pi AI 1.3.0 or later. Before publication, build and pack it from the Unprice workspace and install its local archive. The shared `@unprice/budgets-ai` package must also be installed from its archive during local testing.

```ts
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Harness } from "@earendil-works/pi-durable";
import { Unprice } from "@unprice/budgets";
import { withUnpriceBudget } from "@unprice/pi-budget";

const unprice = new Unprice({ token: unpriceToken });
const models = createModels();
models.setProvider(
  withUnpriceBudget(openaiProvider(), {
    getBudget: () => unprice.budget(customerBudgetKey),
    maxOutputTokens: 4096,
  }),
);

const harness = await Harness.open(storage, { models, registry }, context);
```

Create the Unprice budget before running the harness. Your application owns the
customer ID, budget key, unit, limits, and credentials. The adapter receives only
the budget handle. Use a USD-denominated budget because Pi reports model cost in
USD. Register every paid provider through the adapter.

On Cloudflare, also pass `waitUntil: (work) => ctx.waitUntil(work)`. Other runtimes
can omit this callback and await the returned provider stream or harness work.

| Option            | Meaning                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `getBudget`       | Returns the budget handle for each model call, directly or asynchronously.                             |
| `waitUntil`       | Optional host callback that keeps the call lifecycle alive.                                            |
| `maxOutputTokens` | Requested output ceiling. Defaults to 4096. Model limits and available funds can reduce it.            |
| `budgetTimeoutMs` | Shared admission deadline and separate settlement deadline. Defaults to 10000 ms.                       |
| `onSettleError`   | Receives `BudgetSettleError` for recovery. The terminal stream event waits for an asynchronous callback. |

## Priced tools

Install Pi Durable 1.3.0 or later to wrap a tool registration. Declare its fixed
price once. The wrapper charges before execution and records that fee in Pi's
native tool usage.

```ts
import { withUnpriceTool } from "@unprice/pi-budget/tools";

const weather = withUnpriceTool(weatherTool, {
  amount: 0.01,
  getBudget: () => unprice.budget(customerBudgetKey),
  sessionId: stableSessionId,
});
```

Register `weather` in the Harness registry and the agent's tools. Return a remote
budget handle from `getBudget`. Local handles are rejected because their charge
deduplication ends with the lease. The provider wrapper can still use local handles
for the same budget key. Amounts are in USD and accept numbers or
decimal strings. No token counters or usage object are needed in application code.

`sessionId` identifies the Harness storage. Keep it stable across restarts and
distinct across sessions that share a budget. The charge key combines it with
Pi's task ID. Replaying a task reuses its charge; a new task pays the fee again.
The wrapper preserves the tool's schema, replay policy, output, and details.
It adds the fee to any existing `usage.cost.total` without changing token counts.
It charges only the fixed fee, not costs already reported by the tool.

A denied or failed charge blocks execution. The fee pays for an execution attempt
and is not refunded if the tool fails. A returned error result includes the fee
in its usage. Thrown errors propagate; they do not return a tool usage result.
Budget clients should set their own HTTP timeout, as in the provider example.

## Supported requests

This version supports OpenAI Responses, Anthropic Messages, and Gemini Developer API with explicit text transcripts and local function tools. Wrap `openaiProvider()`, `anthropicProvider()`, or `googleProvider()` with the same decorator. Unsupported APIs, media, hosted operations, model fallback, explicit Gemini caches, and one-hour Anthropic cache writes fail before generation.

Model limits and prices come from Pi's own model definitions (`model.cost`, `model.contextWindow`, `model.maxTokens`), including context tiers and cache writes, and must match the endpoint. The shared SDK prices the final request's byte bound at the highest reachable rates. A context tier above the input bound cannot inflate the hold. The output allowance includes thinking tokens.

A funded call sends no provider count request. After a definite limit denial, OpenAI Responses can refine its input with one accurate provider count. Count failures retain the byte bound. Anthropic and Gemini keep their byte bounds because their count endpoints provide estimates. The SDK selects the largest legal output allowance that fits and authorizes the final amount before generation. Every call still sends at most one generation request.

Applications provide the model and budget handle. They do not supply token counts or per-call cost estimates. `maxOutputTokens` is a ceiling, so low funds can produce a shorter or truncated answer. Native Pi usage and finish reasons describe the result. Anthropic enabled thinking retains its minimum allowance. Anthropic error or cancellation uses the full hold because Pi can report input usage before final output usage is available.

Recent Pi Anthropic models can enable fallback models or inline tool changes by default. These requests are rejected. For a single-model request with ordinary local tools, configure the model with `compat: { ...model.compat, allowedFallbackModels: [], supportsMidConvoToolChanges: false }` before calling it. This keeps those provider features off explicitly.

Pi 1.3 rejects a custom Google fetch transport. The adapter therefore uses Pi's public Google transcript/tool conversion helpers with an explicit REST/SSE transport. Auth is still resolved by `createModels`; headers, payload transforms, thought signatures, tool calls, and normalized usage pass through the adapter. This bridge is specific to the Google Generative AI API. Calls use the standard service tier, no automatic
provider retries, a two-minute deadline, and a five-minute budget hold.
Policy runs after the caller's payload transform so Pi selects the correct stream parser. The shared request boundary then verifies the final serialized body. Both stages preserve smaller output allowances from Pi or the caller. The bound is computed on the same final request body that is sent.

Budget resolution, count refinement, and authorization share a ten-second deadline and stop waiting
when the caller cancels. Settlement has its own ten-second deadline and continues
after caller cancellation. Set `budgetTimeoutMs` to change these operation limits.
The example's Unprice client also aborts each HTTP attempt after ten seconds.
Custom budget clients should set a transport timeout too. The adapter can stop
waiting for a custom handle, but it cannot cancel that handle's HTTP requests.

The adapter settles Pi's reported `usage.cost.total` before it emits the terminal
stream event. Settlement failure returns an error while retaining measured usage
and response content. A timed-out request may still complete remotely. Unknown usage consumes the reservation conservatively.
After process loss, unresolved holds can expire at their full reserved amount.
This can count more than the actual provider cost.

Use `onSettleError` to retain the settlement intent. The error exposes `hold`,
`recovery`, and `retry()`. The Pi result still reports an error and retains its
measured usage and response content.

```ts
withUnpriceBudget(openaiProvider(), {
  getBudget: () => unprice.budget(customerBudgetKey),
  onSettleError: async (error) => {
    await recoveryStore.put(error.idempotencyKey, {
      budgetKey: error.hold.key,
      holdId: error.hold.id,
      actual: error.actual,
      recovery: error.recovery,
    });
    // A live process can also call await error.retry() to finish this intent.
  },
});
```

`recoveryStore` is application-owned durable storage. An excess record keeps its
original amount, event key, and `occurredAt` on every retry. The retry function
exists only in the live process. Process loss before the intent is stored can
lose unrecorded excess usage; hold expiry covers only reserved capacity. A
callback failure rejects the lifecycle promise passed to `waitUntil`; the Pi
stream still ends with its settlement error. Without `waitUntil`, that terminal
error completes the call and the callback rejection is handled by the adapter.

The provider wrapper uses Pi AI's public provider contract. The tool wrapper uses
Pi Durable's public tool contract through a type-only import in `@unprice/pi-budget/tools`.
Pi Durable is an optional peer dependency. The root export does not require its
type declarations. Neither wrapper imports Cloudflare runtime code.

The shared request policy and budget lifecycle live in `@unprice/budgets-ai`. This adapter only converts Pi requests, stream events, and reported USD cost.

The Pi adapter is ESM-only because Pi AI exposes ESM-only entry points. CommonJS callers must load it with dynamic `import()`. The shared AI package and AI SDK adapter also provide CommonJS exports.
