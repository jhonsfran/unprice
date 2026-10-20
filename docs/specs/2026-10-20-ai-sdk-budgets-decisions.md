# Budgets for AI SDKs: decision record

## Status

Draft, 2026-10-20. Revised the same day after a design review. Each decision carries its own
status:

- **Decided**: agreed.
- **Proposed**: recommended, waiting for a decision.
- **Open**: needs a test or a fact first.
- **Rejected**: considered and replaced. The text stays so the reasoning is not lost.

Scope: `@unprice/budgets`, `@unprice/budgets-ai`, `@unprice/ai-sdk-budget`, `@unprice/pi-budget`, and
the budget server. Builds on [ADR-0005](2026-10-14-adr-0005-rate-cards-and-budget-runtime.md) and
[ADR-0006](2026-10-16-adr-0006-budget-primitive.md).

## The problem

A developer who caps AI spend must reserve a cost before each call, and nobody can predict what a
model loop costs. The adapters today reserve a worst case that is too large, and they ask the
developer for numbers Unprice should own:

- Anthropic and Gemini reserve the whole context window at the highest rate across all pricing
  tiers (`packages/budgets-ai/src/provider-request.ts:35`, `packages/budgets-ai/src/index.ts:56-65`).
- In test fixtures, holds are 9× (OpenAI) to 297× (Gemini) the settled cost. Almost all of it is
  the input side. Output is already exact, because the adapter sets `max_tokens` itself.
- OpenAI pays a provider round trip on every step. The adapter posts to `/responses/input_tokens`
  before each call (`packages/budgets-ai/src/openai-request.ts:131`).
- A large hold refuses work. A step near the cap is denied even when its real cost would fit.
- Failures charge the full hold. An unknown outcome settles at the maximum
  (`packages/budgets-ai/src/index.ts:216-219`).
- A real overrun is never counted. The server rejects a settle above the hold
  (`internal/services/src/budgets/decide.ts:526-528`), and the hold expires at its full amount.
- The developer wires four things for one model. A paired `fetch`, a middleware, a price table
  (`getPricing`), and a model-limits resolver (`getModelLimits`). The README at
  `packages/ai-sdk-budget/README.md` shows the full ceremony.
- Every hold gets a random idempotency key (`packages/budgets-ai/src/index.ts:184`). A retry or a
  durable rerun opens a second hold.

Neither Autumn nor Polar blocks a model call before it runs. Autumn's AI SDK wrapper
(`withAutumn`) records usage after the call, and Autumn lets calls through by default when its
service is down. Polar meters after the fact; its docs say it will "never prohibit" an action.
Both read 2026-10-20 from public docs and published package source.

## D1. The developer sets a cap. Unprice sizes each step. (Decided)

The developer sets one number: the limit on a budget key. Nobody estimates a loop.

Before each model step, the adapter computes a bound for the step and reserves it. The adapter
sets the step's output limit (`max_tokens`) so that the step cannot cost more than the hold. After
the call, the step settles with its real usage, and the unused part returns at once.

A `budgetSpent()` stop condition ends the loop cleanly when the next step cannot fit. Partial
grants ("fund up to this much, at least that much"), which let the last step near the cap get a
shorter answer instead of a refusal, come after the three changes in the build order.

## D2. Every step is checked before it runs. The cap is exact wherever a maximum is known. (Decided)

The cap holds when this is true for every step:

```
hold ≥ input bound × input rate + output limit × output rate
```

- **The output limit is set by us when the provider allows it.** Almost every text API has one.
  This is from provider docs as known on 2026-10-20, not re-checked per provider.
- **When the provider does not let us set it, we reserve the model's maximum output.** The hold is
  larger, but the cap still holds. Compatibility does not depend on `max_tokens`.
- **The input bound is a per-provider policy.** See D12. It is never the context window.
- **Some calls cannot be capped.** These are calls with no usage report, an unknown price, or a
  provider-run tool billed per call with no limit. Hard budgets refuse them by default. Images are
  refused today and get a per-provider token formula in the catalog later (D5).
- **An opt-in `bounded` level** reserves the minimum, settles the actual cost, and allows at most
  one step over the cap, recorded. It is for developers who value compatibility over a
  cent-exact cap. It is not in the first release.

Every step reports which level applied, `exact` or `bounded`.

Why: the market pain is runaway spend from loops, free-tier abuse, and overspent prepaid
credits. Two properties fix it: no new step starts when the budget is gone, and the overshoot has
a known maximum. The cent-exact cap is what neither Autumn nor Polar offers. The model-maximum
fallback keeps it on most providers.

A violated bound is counted, not hidden. The server rejects a settle above the hold, so the adapter
settles the hold in full and records the excess with `record`, which always counts, even past a
hard limit. The overrun lands in the budget, the step reports `exceeded`, and the cap was passed
by at most that one step. What a wrong bound costs is one step of overshoot.

## D3. The budget's unit is a wrapper option. The server checks it. (Decided, not built)

Nothing checks units today. A budget's unit is `money:<code>`, `credits:<id>`, or `units:<slug>`
(`internal/db/src/validators/budgets.ts:155`). `budgets-ai` and both adapters never read it, and
`authorize` takes an amount only (`packages/budgets/src/budgets.ts:116`). So a $0.043 call
against a `units:sdk` budget reserves 0.043 units, with no error.

Decision: the adapter states the unit it prices in, `money:USD` by default. The request carries it.
The budget's Durable Object rejects a mismatch with `UNIT_MISMATCH` before it opens a hold. The
check is one string compare inside a call we already make, so it adds no round trip.

| Budget unit | One model step reserves | Pricing needed |
|---|---|---|
| `money:USD` | priced tokens or media | yes |
| `units:tokens` | the token bound | no |
| `credits:<id>` | the priced amount, converted to credits | yes, plus a conversion rate (not built) |
| `units:requests` | 1 | no |

A `units:tokens` budget is the simplest exact cap: it needs no price catalog and has no price
drift. It is a good first release for free trials.

Not built as of 2026-10-20: the adapters still reserve USD amounts against a budget of any unit,
and the server does not compare units.

## D4. Prices are server data. The SDK prices with them. (Decided)

The server serves catalog rows per model id. A row carries the token rates, context tiers, the
input and output limits, and later a media or image formula (D5). Unprice curates the rows from
models.dev and can override any of them. A sync script regenerates the rows, so the catalog is a
build artifact a reviewer can rerun, not a hand-edited table.

```ts
// GET /v1/budgets/models?ids=openai/gpt-5,anthropic/claude-sonnet-4-5
{
	version: "2026-10-20",
	models: [{
		id: "openai/gpt-5", provider: "openai", model: "gpt-5", unit: "money:USD", per: 1_000_000,
		rates: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
		tiers: [],
		limits: { context: 400_000, output: 128_000 },
	}],
}
```

**The SDK prices in your process, in every mode.**

1. `unprice.model("openai/gpt-5")` fetches the row once per process and caches it with a short
   TTL. The catalog version comes with it.
2. The bound (D12) and the settled cost use the one pricing function that exists today
   (`usageCost` in `@unprice/budgets-ai`). Remote and local mode share it. Both use the same tier
   rule and the same rounding.
3. A hold and a lease pin the catalog version they were priced with. A catalog update during a
   step cannot push the settled amount past the hold.
4. For audit, settle can carry the usage and the catalog version beside the amount. The server
   does not need it to enforce the cap. It is not in the first release.

**Why the SDK and not the Durable Object.** ADR-0006 B1 defines a budget as a self-contained
counter on one key. The counter stays that way. It never learns what a model is, and a catalog
change is a server deploy or a sync, not a change to the budget core. SDK-side pricing is safe
because the SDK runs in the developer's own backend and the number it protects is the developer's
own cap. Nobody on the client side gains from under-reserving.

**Escape hatch.** For a model the catalog does not know, the developer passes the row:

```ts
budgeted(createOpenAI, { unprice, models: { "my-finetune": { rates, limits } } })
```

The cap holds only if the rates are true. The server cannot verify them, so this stays the
exception.

## D5. Image, audio, and video models are capped by request size. (Proposed, after the three changes)

These models are the main target because they are expensive. Most are easier to cap than LLMs,
because the request decides the price before the call runs. This table is from provider pricing
pages as known on 2026-10-20, not re-checked:

| Kind | Known before the call | Hold | Settle |
|---|---|---|---|
| Image | count, size, quality | exact price | usually equal to the hold |
| Speech (text to speech) | input characters | exact price | equal |
| Transcription | audio duration, read from the file | exact price | equal |
| Video | seconds × resolution | exact price | when the job finishes |
| Token-priced media (realtime audio, token-priced image models) | a token bound | as in D2 | from usage |

Example catalog rows (prices are illustrative):

```ts
{ meter: "image",      price: { "1024x1024:standard": 0.04, "1024x1792:hd": 0.12 } }
{ meter: "characters", price: 15, per: 1_000_000 }
{ meter: "seconds",    by: "resolution", price: { "720p": 0.10, "1080p": 0.30 } }
```

When the price is fixed, use `charge(price)`: one call, before the work. Otherwise, authorize the
maximum and settle the actual cost.

For long jobs such as video:

- The hold must outlive the job. `budgets-ai` hardcodes a 300-second TTL
  (`packages/budgets-ai/src/index.ts:189`), which is too short. The server allows up to 24 hours.
- Settle when the job finishes, from a webhook or a poll.
- Release the hold only when the provider confirms it did not charge.

Image inputs to text models get a token formula in the same catalog row, so the bound in D12
covers them without a count request.

## D6. Paid tools use the same budget. The developer sets their price. (Decided)

The developer pays the tool's vendor, so the developer knows its price. Unprice enforces it. One
question decides the gate: can you name the most one call can cost?

- **Yes, always the same price**: `charge(price)` before the tool runs.
- **Yes, but the price varies**: `authorize(max)` before, `settle(actual)` after.
- **No**: bound it first (max results, page limit, timeout), or record it after the call, outside
  the hard cap.

`budget.wrap({ amount }, fn)` puts a charge in front of a tool's `execute`. The charge's
idempotency key is the AI SDK's `toolCallId`, which `execute` receives in its options, so a
re-executed tool call replays the charge instead of paying twice. Outside the AI SDK, `wrap` uses
a random key per call. Provider-run tools (web search, code interpreter) take their price per call
from the catalog. Hard budgets refuse them unless the provider limits the number of calls per
request.

Who decides what:

| Decision | Who decides | Where it lives |
|---|---|---|
| The cap for a customer or a run | The developer, or the customer's plan | budget limits (upsert, dashboard, `ifMissing`) |
| Model token prices | Unprice, from the models.dev catalog; the developer can override a model | server catalog, cached in the SDK |
| The price of the developer's own paid tools | The developer, when defining the tool | `wrap({ amount }, fn)` |
| The price of provider-run tools | Unprice catalog, per call | refused today; needs a per-call limit |
| The output size of each step | The adapter, from the hold; the developer can set a lower limit | `max_tokens` per step |
| Allow or deny | The budget object for the key | Unprice, one object per key |
| What was actually billed | The provider's usage report | settle |

## D7. Pricing and step sizing move to the server. (Rejected)

Two server calls, `fund { model, unit, inputTokens, output: { want, min } }` and
`settle { holdId, usage }`, were proposed to replace client-side pricing. The adapters would send
tokens and the Durable Object would price them with rates pinned on the hold.

Rejected on 2026-10-20 in favor of D4 and D12. The reasons:

- It moves model knowledge into the counter that ADR-0006 B1 keeps model-free, and it adds two
  verbs and rate pinning to the budget core for a benefit the catalog endpoint delivers with less
  code.
- It gives local mode a second pricing path. A lease is capacity in the budget's unit, so a local
  hold must be priced in the process anyway. One pricing function in the SDK serves both modes.
- Its security argument does not apply. The SDK runs in the developer's backend, and the cap
  protects the developer's own money.

What survives from it: the adapters send no prompts and no provider keys to Unprice, model traffic
stays direct, and each step is still one authorize and one settle. A gateway proxy stays out of
scope. It would work from any language, but it puts Unprice in the path of every model call, and
Unprice would see prompts and API keys.

## D8. The budget key comes from your own IDs. Budgets are created on first use. (Decided)

You build the key from IDs your auth system already has: `customer:${user.id}`,
`org:${org.id}`, `run:${runId}`. You do not create a separate Unprice customer or store an
Unprice ID. Budget keys are free strings (letters, digits, and `: / _ . @ -`), and `upsert`
creates them. This already works: the pi-durable-cloudflare example (separate repository) uses
`pi-durable:customer:${customerId}`.

What changes:

- The docs teach this as the default.
- The AI SDK adapter accepts the key per call, through `providerOptions.unprice.budget`. The
  wrapper's `budget` option is the default when a call names none.

Create budgets on first use:

```ts
const budget = unprice.budget(`customer:${user.id}`, {
	ifMissing: { unit: "USD", limits: [{ amount: "5", window: "month", enforce: "hard" }] },
})
```

1. `authorize`, `charge`, and `lease` carry `ifMissing`. It is the upsert body without the key.
2. If the key has no budget, the Durable Object creates it from `ifMissing` and runs the verb in
   the same transaction. Today, a verb on a key that was never upserted returns
   `BUDGET_NOT_FOUND`, and the Durable Object creates no storage for it.
3. If the budget exists, the Durable Object ignores `ifMissing`. It never changes an existing
   budget, so it cannot loosen a cap. A runtime key creates with `mayLoosen: false`, as upsert does.
4. The reply says `created: true`, and the route writes the dashboard catalog row the way
   `upsertBudget` writes it today.
5. Two concurrent first calls are safe, because the Durable Object runs them one at a time. The
   second finds the budget and ignores its `ifMissing`.

The wrapper takes the same definition as `defaults`. This removes a signup step that Autumn
requires (`getOrCreate` at signup). Later, dashboard templates by key prefix (for example,
`customer:*` gets $5 a month) can replace `ifMissing` in code.

## D9. Durable runtimes key holds from durable IDs. (Proposed, after the three changes)

This is the fix for Pi Durable.

**Problem.** `budgets-ai` gives every hold a random idempotency key
(`packages/budgets-ai/src/index.ts:184`). Pi Durable reruns a generation that a crash
interrupted. The rerun opens a second hold. The first hold expires after 300 seconds and is
charged in full. One eviction charges a step twice against the cap. The cap stays safe. Capacity
is over-counted until the first hold expires.

**What Pi provides.** Pi forwards the conversation's `sessionId` to every model call
(`StreamOptions.sessionId` in `@earendil-works/pi-ai`). It survives restarts, but every step in the
conversation shares it.

**Fix, in two steps:**

1. **Now, in `@unprice/pi-budget`.**
   - Build the hold key from `sessionId`, the transcript length, the model, and an attempt counter.
     The counter lives in process memory.
   - After a restart, the counter starts at 0, so the rerun reuses the hold the crash left open.
   - A provider retry in the same process increments the counter and opens a new hold.
   - Open: if the crash came after settle, the replayed authorize returns a closed hold. The client
     must detect that and move to the next attempt.
2. **Later, upstream.** Ask Pi to forward a per-generation ID (task ID plus attempt) in its stream
   options. That removes the hashing.

Changes for the pi-durable-cloudflare example:

- Create the budget on first use (D8). Today it returns 503 when provisioning at session creation
  fails.
- Send the unit (D3).
- Cap each run inside the customer's daily cap, for subagents and scheduled follow-ups. This needs
  parent and child budgets (ADR-0006 B6), which are not built.
- Check whether `ctx.waitUntil` does anything inside a Durable Object.

## D10. `waitUntil` exists for accurate settlement. The cap is safe without it. (Decided)

The AI SDK adapter registers a promise when the call starts and resolves it after settlement
(`packages/ai-sdk-budget/src/index.ts:163-182`). The Pi adapter registers its whole work promise
(`packages/pi-budget/src/index.ts:191`). The platform keeps the function alive until settlement
finishes. This matters when the client disconnects, or when the handler returns a streaming
response early.

Without `waitUntil`, the platform can stop the function before settle runs. The hold stays open,
expires after 300 seconds, and is charged in full. The cap stays safe, because spend is
over-counted, never under-counted. What suffers is accuracy, and the capacity stays locked until
the hold expires.

Platform support, from platform docs as known on 2026-10-20, not re-checked:

| Platform | How to keep settlement alive |
|---|---|
| Cloudflare Workers | `waitUntil: (p) => ctx.waitUntil(p)` |
| Vercel, Next.js | `waitUntil` from `@vercel/functions`, or Next.js `after()` |
| Netlify | `context.waitUntil` |
| AWS Lambda | None. Settle before the response ends. `generateText` already settles before it returns, and streams settle before their finish part. |
| Long-running Node or Bun | Not needed |

The adapter docs must state this table and the failure behavior.

## D11. Distribution: one wrapper per framework, a budgets skill, and adapter docs. (Decided for the wrapper, Proposed for the rest)

**Wrappers.** Each framework gets one wrapper that returns the same model type, in one line.

```ts
const openai = budgeted(createOpenAI, { unprice })
const model = openai("gpt-5")
```

For the AI SDK, `budgeted` calls the provider factory with the paired `fetch`, wraps every model
the provider returns with `wrapProvider` from `ai`, and returns a callable provider. The protocol
comes from the model's own `provider` field (`openai.responses`, `anthropic.messages`,
`google.generative-ai`), so one wrapper serves every supported provider and the developer names
no protocol. The paired `fetch` and the middleware stay exported for a provider the factory cannot
build, but they are no longer the way in. Pi keeps `withUnpriceBudget(provider, …)`. Autumn and
Polar both use this one-line pattern.

Three packages stay public: `@unprice/budgets`, `@unprice/ai-sdk-budget`, and
`@unprice/pi-budget`. `@unprice/budgets-ai` is the shared request policy that nobody installs
directly.

**A separate `unprice-budgets` skill.** Do not grow `integrate-unprice-sdk`.

- A skill loads when its description matches the task. Capping AI spend is a separate job, with a
  separate reader and separate packages. Today `integrate-unprice-sdk` mixes budgets with plans,
  entitlements, and billing.
- Remove the budget parts from `integrate-unprice-sdk`, and point budget questions to the new
  skill.
- `SKILL.md` routes to the right integration and covers the five choices a developer makes: key,
  unit, limit, tool prices, and runtime (serverless or local).
- Reference files: AI SDK, Pi, manual `spend`, units, serverless, and errors and failures.
- Ship the skill inside the `@unprice/budgets` npm package, as `@polar-sh/sdk` ships
  `.agents/skills/`. Keep it in the repository too, and link it from the docs page that already
  gives agents the integration skill (`quickstart/agent-integration`).

**llms.txt already exists.** Mintlify serves `https://docs.unprice.dev/llms.txt`, which lists the
budget pages, and every page has a `.md` version (verified 2026-10-20). The work is content:

- Add pages: `budgets/ai-sdk`, `budgets/pi`, `budgets/units`, `budgets/tools`, and
  `budgets/serverless`, plus a table of defaults and failure behavior.
- Change the budgets quickstart to show the adapters first. Today it teaches a hand-written
  `costOf`.

## D12. The input bound is a per-provider policy. Bytes first, count near the cap. (Decided, bound Open)

The input side carries the over-hold. The two fixes before this one, the maximum rate across tiers
and the context-window reservation, shared one premise: the bound must be proven without asking
the provider or the previous step. Both produced holds nobody can use. The provider knows the
number, and so does the previous step. The policy gets it from them.

The policy is a table keyed by protocol, in `@unprice/budgets-ai`:

| Input | Bound | Cost |
|---|---|---|
| Text, tool definitions, tool results | UTF-8 bytes of the serialized request body, plus a fixed overhead per message | none |
| A provider's hidden tool-use prompt | a fixed reserve per protocol when the request carries tools: 1024 tokens for Anthropic, which documents 264 to 804 tokens by model and `tool_choice` (read 2026-10-20); 0 for OpenAI and Gemini, whose documentation lists none | none |
| Images | the catalog row's per-provider formula (D5), later | none |
| Anything the table cannot bound | refused on a hard budget | none |

Why bytes. Every byte-level BPE tokenizer and every SentencePiece tokenizer with byte fallback
emits at least one byte per token, so tokens never exceed bytes. Chat templates add a few tokens
per message, which the per-message overhead covers; the per-protocol reserve covers what a
provider adds outside the body. This is inferred from how those tokenizers work. It is not
verified against Anthropic's or Gemini's tokenizer, which is the open question below. A violated
bound is counted (D2). The cost is an over-hold of about three to four times the input cost for
English text, which strands concurrency near the cap.

**Near the cap, count exactly.** When the byte-bound authorize is denied, the adapter asks the
provider's count endpoint for the exact input count and retries once. OpenAI's
`/responses/input_tokens` is exact. Anthropic's `count_tokens` and Gemini's `countTokens` are
documented as estimates, so the retry pads them. This fallback is the one place a step pays a
provider round trip, and it comes after the three changes. Until then a denied byte bound is a
denial, which is what happens today at a far larger bound.

**What this replaces.** OpenAI no longer counts on every step. Anthropic and Gemini no longer
reserve the context window. The `modelLimits` option and the trusted-limit resolver go away. The
limits now come from the catalog row and only clamp `max_tokens`.

## Developer experience target

The AI SDK integration this record aims for:

```ts
const openai = budgeted(createOpenAI, {
	unprice,
	defaults: { unit: "USD", limits: [{ amount: "5", window: "month", enforce: "hard" }] },
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

One wrapper, one budget key, and a price on each paid tool. No price table, no model limits, and
no hand-wired `fetch`.

## Build order

Tests come before code in every unit. Each unit lands on its own, verified, before the next.

1. **Catalog rows from the server, priced in the SDK (D4, D12).** Landed 2026-10-20 on `feat/sdks`.
   - Tests: the catalog route returns rows with tiers converted from models.dev and omits unknown
     ids. `unprice.model(id)` fetches once per id per TTL. For each protocol the hold equals the
     byte bound times the input rate plus `max_tokens` times the output rate. No count request is
     sent. An opt-in test checks the byte bound against real Anthropic and Gemini counts; it needs
     provider keys and has not run yet.
   - Code: the sync script and the generated rows, the route, the SDK cache, the bound table, and
     the deletion of `getPricing`, `getModelLimits`, and the OpenAI count. `TokenPricing` stays as
     the type of the pricing arithmetic.
2. **One wrapper, the key per call, budgets created on first use (D8, D11).** Landed 2026-10-20 on `feat/sdks`.
   - Tests: a three-step tool loop through `generateText` opens one hold per step, each under the
     key from `providerOptions`. `budgeted` detects the protocol from the model for OpenAI,
     Anthropic, and Gemini. An authorize with `ifMissing` on an unknown key creates the budget and
     opens the hold in one transition, writes the catalog row, and never changes an existing
     budget.
   - Code: `budgeted`, `providerOptions.unprice.budget`, `ifMissing` in the core, the Durable
     Object, the routes, and the handle.
3. **Priced tools and the stop condition (D6).** Landed 2026-10-20 on `feat/sdks`.
   - Tests: `wrap` charges once per `toolCallId` across a re-execution. `budgetSpent()` stops a loop
     after the step whose settlement leaves less than the next step's minimum.
   - Code: `wrap` on the handle, `providerMetadata.unprice` on every step, `budgetSpent`.

After the three: partial grants on `authorize` with a `min` (D1), the count fallback near the cap
(D12), image formulas (D5), stable hold keys for Pi Durable (D9), the `unprice-budgets` skill and
the docs pages (D11), and media rate cards with job-length holds (D5).

## Open questions

- Is `tokens ≤ UTF-8 bytes + overhead` a true bound for Anthropic and Gemini? The opt-in test in
  `@unprice/budgets-ai` answers it when provider keys are present. Without keys it is
  unverified. D12 ships on the inference, and D2 names the failure mode. Anthropic's hidden
  tool-use prompt was the first thing outside the body that the bound missed; it is reserved now.
- Do Gemini thinking tokens count inside `maxOutputTokens`?
- When authorize replays a hold that was already settled, does the response say it is closed?
  D9 depends on this.
- Does models.dev cover media prices, or does Unprice maintain those rows? Its token rows carry
  `input`, `output`, `cache_read`, `cache_write`, and context tiers (read 2026-10-20).
- Do providers charge for failed media jobs?
- Does `ctx.waitUntil` do anything inside a Durable Object?
- What rate converts money to credits for `credits:<id>` budgets, and who sets it?
