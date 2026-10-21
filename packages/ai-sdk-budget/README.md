# @unprice/ai-sdk-budget

Cap AI spend per customer, run, or agent in the Vercel AI SDK. One wrapper puts every model step
inside an Unprice budget: before the step runs, the adapter reserves what the step can cost at
most and caps its output; after it runs, the step settles at its real usage. A step the cap cannot
cover never reaches the provider.

```bash
pnpm add @unprice/ai-sdk-budget @unprice/budgets
```

Requires AI SDK 7 and one of `@ai-sdk/openai`, `@ai-sdk/anthropic`, or `@ai-sdk/google`.

## Use

```ts
import { createOpenAI } from "@ai-sdk/openai"
import { budgetSpent, budgeted } from "@unprice/ai-sdk-budget"
import { Unprice } from "@unprice/budgets"
import { generateText, stepCountIs, tool } from "ai"
import { z } from "zod"

const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN! })

const openai = budgeted(createOpenAI, {
  unprice,
  defaults: { unit: "USD", limits: [{ amount: "5", window: "month" }] },
})

const run = unprice.budget(`run:${runId}`)

const search = tool({
  inputSchema: z.object({ q: z.string() }),
  execute: run.wrap({ amount: 0.01 }, searchApi),
})

await generateText({
  model: openai("gpt-5"),
  tools: { search },
  stopWhen: [stepCountIs(20), budgetSpent()],
  providerOptions: { unprice: { budget: run.key } },
})
```

`budgeted` takes the provider factory and returns a provider whose language models run inside
the budget. Pass the factory's own settings as the third argument; your `fetch` there still
carries the model traffic.

Each call names its budget in `providerOptions.unprice.budget`. A call that names none uses the
wrapper's `budget` option. With `defaults`, the first call on a key that has no budget creates
one from that definition; an existing budget is never changed. Keys are your own ids.

`wrap({ amount }, fn)` charges a fixed price before a tool runs, keyed by the AI SDK's
`toolCallId`, so a tool call that runs again does not pay twice. `budgetSpent()` ends the loop
once the last step left less than the next step would need, instead of failing on a denied hold.

## What a step costs

Prices and limits come from the Unprice catalog, fetched once an hour per model and shared by
every call in the process. You maintain no price table. The hold for a step is the byte bound of
the request body at the model's highest input rate, plus the output limit at its output rate, plus
Anthropic's hidden tool-use prompt when the step carries tools. Byte-level tokenizers never emit
more tokens than bytes, so the step cannot cost more than the hold. Settlement returns the
difference at once. No count request goes to the provider.

The protocol comes from the model itself: OpenAI Responses, Anthropic Messages, and Google
Generative AI. A model the catalog does not know is refused before any hold; pass its row in
`models`:

```ts
budgeted(createOpenAI, {
  unprice,
  models: {
    "openai/my-finetune": {
      rates: { input: 2, output: 8, cacheRead: 1, cacheWrite: 2 },
      limits: { context: 128_000, output: 16_384 },
    },
  },
})
```

Every step carries `providerMetadata.unprice` on its result and on a stream's finish part:
`budget`, `holdId`, `hold`, `actual`, `remaining`, `exceeded`, and `exhausted`. `exhausted` is
true once what is left is less than a step with this step's prompt and the output cap would
reserve; `budgetSpent()` reads it. `exceeded` is true when the step cost more than its hold: the
hold was settled in full and the excess recorded against the budget, past the cap.

## Options

| Option            | Meaning                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `unprice`         | The `Unprice` client.                                                                        |
| `budget`          | The key of a call that names none in `providerOptions`.                                      |
| `defaults`        | The budget to create on first use: `unit`, `limits`, and the other upsert fields.            |
| `budgets`         | `(key) => handle`, for local mode: `(key) => unprice.budget(key, { mode: "local", lease })`. |
| `models`          | Rates and limits by `provider/model` id, replacing or adding catalog rows.                   |
| `maxOutputTokens` | The output cap of every step. Defaults to 4096; the model's own limit clamps it.             |
| `budgetTimeoutMs` | The deadline of each budget call. Defaults to 10 seconds.                                    |
| `waitUntil`       | Keeps settlement alive after the response: `(work) => ctx.waitUntil(work)` on Workers.       |

Set `maxRetries: 0` on `generateText` and `streamText` unless you want paid retries: each attempt
is a step with its own hold.

## What is refused

Text and local function tools are budgeted. Image and file parts, provider-run tools, explicit
Gemini caches, one-hour Anthropic cache writes, and the OpenAI chat completions API are refused
before any hold, so a request the bound does not cover never runs.

## When something fails

Generation returns only after settlement; a stream's finish part waits for it. Cancellation, a
missing usage report, or an incomplete stream settles the full hold. A step that cost more than
its hold records the excess first, then settles the hold in full. A failed settlement throws
`BudgetSettleError` with the hold, `recovery` data, and a `retry()` function. Retry completes the
original accounting without running the model again. Persist the hold identity and recovery data
if recovery must survive process loss. The hold is never released, and an open hold expires at
its full amount.

Without `waitUntil` on a platform that stops the function at the response, settlement may not run
and the hold expires at its full amount. The cap stays safe; accuracy and capacity suffer until it
expires.

## Lower level

`createUnpriceBudgetMiddleware(options)` returns `{ fetch, middleware }` for a provider `budgeted`
cannot build. Give the provider the `fetch` and wrap each model with the `middleware`; the two are
paired, and a request that reaches the `fetch` without the middleware is refused.
