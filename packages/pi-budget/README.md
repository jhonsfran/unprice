# Unprice budgets for Pi

This package provides `withUnpriceBudget`. It wraps a Pi AI
provider before registration with `createModels`. The same provider handles Pi
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
| `maxOutputTokens` | Maximum output allowance. Defaults to 4096 and must be an integer of at least 16.                      |
| `budgetTimeoutMs` | Deadline for budget resolution and authorization, and separately for settlement. Defaults to 10000 ms. |

## Supported requests

This version supports OpenAI Responses, Anthropic Messages, and Gemini Developer API with explicit text transcripts and local function tools. Wrap `openaiProvider()`, `anthropicProvider()`, or `googleProvider()` with the same decorator. Unsupported APIs, media, hosted operations, model fallback, explicit Gemini caches, and one-hour Anthropic cache writes fail before generation.

Every protocol reserves the byte bound of the final request body at the model's highest input rate, plus the output cap at its output rate; no count request goes to the provider. Byte-level tokenizers never emit more tokens than bytes, so the hold covers the step. Model limits and prices come from Pi's own model definitions (`model.cost`, `model.contextWindow`, `model.maxTokens`), including context tiers and cache writes, and must match the endpoint. The output cap includes thinking tokens. Anthropic error or cancellation uses the full hold because Pi can report input usage before final output usage is available.

Recent Pi Anthropic models can enable fallback models or inline tool changes by default. These requests are rejected. For a single-model request with ordinary local tools, configure the model with `compat: { ...model.compat, allowedFallbackModels: [], supportsMidConvoToolChanges: false }` before calling it. This keeps those provider features off explicitly.

Pi 1.3 rejects a custom Google fetch transport. The adapter therefore uses Pi's public Google transcript/tool conversion helpers with an explicit REST/SSE transport. Auth is still resolved by `createModels`; headers, payload transforms, thought signatures, tool calls, and normalized usage pass through the adapter. This bridge is specific to the Google Generative AI API. Calls use the standard service tier, no automatic
provider retries, a two-minute deadline, and a five-minute budget hold.
Policy runs after the caller's payload transform so Pi selects the correct stream parser. The shared request boundary then verifies the final serialized body. Both stages preserve smaller output allowances from Pi or the caller. The bound is computed on the same final request body that is sent.

Budget resolution and authorization share a ten-second deadline and stop waiting
when the caller cancels. Settlement has its own ten-second deadline and continues
after caller cancellation. Set `budgetTimeoutMs` to change these operation limits.
The example's Unprice client also aborts each HTTP attempt after ten seconds.
Custom budget clients should set a transport timeout too. The adapter can stop
waiting for a custom handle, but it cannot cancel that handle's HTTP requests.

The adapter settles Pi's reported `usage.cost.total` before it emits the terminal
stream event. Settlement failure returns an error while retaining measured usage
and response content. A timed-out request may still complete remotely. Unknown usage consumes the reservation conservatively.
After process loss, unresolved holds can expire at their full reserved amount.
This preserves the spending cap but can count more than the actual provider cost.

The adapter has no Cloudflare or Pi Durable dependency. Its implementation uses
Pi AI's public provider contract. It is a provider decorator, not a Pi Durable
extension hook or a built-in middleware registrar.

The shared request policy and budget lifecycle live in `@unprice/budgets-ai`. This adapter only converts Pi requests, stream events, and reported USD cost.

The Pi adapter is ESM-only because Pi AI exposes ESM-only entry points. CommonJS callers must load it with dynamic `import()`. The shared AI package and AI SDK adapter also provide CommonJS exports.
