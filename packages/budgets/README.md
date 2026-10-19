# @unprice/budgets

Hard caps for AI agents. A budget sits on any key you choose (a customer, a run, an agent, an API
key) and is checked before the work runs: remotely, or from a lease held in your process's memory.
Nothing else in your billing stack changes.

The budget client of [`@unprice/api`](../api/README.md), on its own. Its `Unprice` client has the
same `unprice.budgets.*` operations, `unprice.budget(key)` handles and `unprice.close()` as
`@unprice/api`, which re-exports this package's handles, errors and types, so code moves between
the two by changing the import.

## Installation

```bash
pnpm add @unprice/budgets
```

```ts
import { Unprice } from "@unprice/budgets"

const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN! })
```

The client takes the same options as `@unprice/api`: `baseUrl`, `retry`, `fetch`, `headers`,
`cache`, `debug`, `disableTelemetry`, `waitUntil` and `onSettleError`.

## Budgets

A budget enforces hard usage caps under a key you choose. `estimate` is the maximum authorized
usage. Actual usage must stay within that amount. Define the budget once with `budgets.upsert`,
then take a handle with `unprice.budget(key)`. The handle never creates or changes the budget.
Each upsert sends the whole definition; a field it leaves out takes its default, so an omitted
`closesAt` reopens a closing budget. Instants such as `closesAt` and `anchor` are epoch
milliseconds. A budget with `closesAt` is deleted 30 days after it closes; `get` then returns 404,
and an upsert creates it anew. Give short-lived budgets, such as one per run, a `closesAt`.

A runtime key can create a budget and tighten it. Raising or removing a hard limit, making it
soft, or clearing or postponing `closesAt` needs a **config** key and returns 403 otherwise, so
code that spends under a cap, or an agent that holds its key, cannot lift the cap. A runtime key
also cannot close a budget in the past: an earlier `closesAt` takes effect now. Keep the config
key out of the environment that spends.

Every budget snapshot carries `operations`, the accepted calls that changed the budget per verb
since it was created. Replays, rejections, and reads are not counted.

```ts
await unprice.budgets.upsert({
  key: "customer:acme",
  unit: "USD",
  limits: [{ amount: "50", window: "month" }],
})

const acme = unprice.budget("customer:acme")
const maxOutputTokens = 256
const maximumCost = maximumCostOf({ model, prompt, maxOutputTokens })

const text = await acme.spend(
  { estimate: maximumCost, idempotencyKey: request.id },
  async () => {
    const r = await generateText({ model, prompt, maxOutputTokens })
    return { value: r.text, actual: costOf(r.usage) }
  }
)
```

`maximumCostOf` and `costOf` are application functions. Calculate the maximum from every billable
unit, including input usage and the configured output limit. The provider integration must enforce
that limit across the whole callback. A budget cannot stop an external provider by itself.

`spend` reserves that maximum, runs the function for a new authorization, and settles its final
usage. Pass a stable `idempotencyKey` for each operation. If omitted, `spend` generates one and
includes it as `error.idempotencyKey` in its budget errors.

If the function throws, `spend` throws `BudgetRecoveryError` with `reason: "work_failed"`, the
original `cause`, and the hold. It retains the hold because a provider timeout can follow billable
work. Check the provider's result, then settle known usage with `error.hold.settle({ amount })`.
Call `error.hold.release()` only after confirming that usage is zero. A zero-usage result can also
return `actual: 0` from the function.

If an authorization under your own `idempotencyKey` replays, `spend` throws `BudgetRecoveryError`
with `reason: "authorization_replayed"` and the hold. It does not run the function again. Recover
the provider's result and settle through that hold. A generated key never leaves the call, so its
replay only means the client retried a lost response, and `spend` runs the function. The key
protects budget accounting within its retention period. It does not provide exactly-once provider
execution. Use the provider's own idempotency or a durable workflow when the work must survive
process failure.

`BudgetExceededError` means a limit denied the estimate; `error.blocked` names the limit and the
remedy. `BudgetUnavailableError` means Unprice could not be reached after the client's retries, and
the function did not run. The authorization may still have committed, so retry with the same
estimate, TTL, and `error.idempotencyKey`. If that retry throws `BudgetRecoveryError` with
`reason: "authorization_replayed"`, the first attempt committed and the work never ran: run it and
settle through `error.hold`, or release that hold. `BudgetRequestError` means the API rejected the
authorization.

`BudgetSettleError` retains the work's `value`, `actual`, hold, and key when settlement fails.
An API failure is in `error.error`. A thrown validation or transport failure is in `error.cause`.
After a transport failure, retry `error.hold.settle({ amount: error.actual })`. Do not rerun the
work or `record` that usage, because the first settle may have committed. Usage above the maximum
returns 409 and keeps the hold open. Reconcile that provider failure. Do not clamp the amount or
release the hold to conceal the excess.

In a serverless function, pass the platform's `waitUntil` to the client so the settle does not
delay the response. `spend` then returns the work's value as soon as the function finishes and
settles in the background. Authorization errors, denials, and `BudgetRecoveryError` still throw
from `spend`. A failed settle is passed to `onSettleError` as a `BudgetSettleError` instead. Its
hold stays open and counts its full estimate when it expires, so a lost settle can over-count
usage, never under-count it.

```ts
import { waitUntil } from "@vercel/functions"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN!,
  waitUntil,
  onSettleError: (error) => console.error(error.message, error.actual),
})
```

Next.js `after` works the same way; on Cloudflare Workers, create the client in the handler with
`waitUntil: (promise) => ctx.waitUntil(promise)`.

For manual control, `acme.authorize({ amount, idempotencyKey })` returns `{ result }` or `{ error }`.
The result is `{ allowed: true, hold }` or `{ allowed: false, blocked }`.
Manual `authorize` and `charge` require a caller-provided key. Keep it before sending, then retry
an uncertain result with the same key and input. `hold.settle({ amount })` and `hold.release()`
are safe to retry because the hold id is the idempotency key. Pass a `ttlMs` that covers the work:
a hold still open at its `expiresAt` is settled at its full amount, never released. That capacity
stays used until its window resets, and afterwards only a settle of the full amount succeeds; any
other settle or release returns 409. A closed hold retains its result for 24 hours; later retries
return 409 instead of counting twice.
`acme.charge({ amount, idempotencyKey })` gates a one-shot amount, and
`acme.record({ amount, idempotencyKey, occurredAt })` reports usage that already happened. It
always counts, even past a hard limit, and its `crossed` names each limit it passed; a crossed
hard limit then denies `authorize` and `charge`. Authorize before work that needs guaranteed capacity.
The API also rejects a lower hard cap when consumption plus open holds would exceed it.
Pass the event's id as the record key and its own time as `occurredAt`, never the call time.
For 8 days the same key and amount count once and another amount returns 409. Usage older than
7 days returns 409, so a retry that resends the event's time cannot count twice.
Amounts accept numbers or decimal strings and come back as decimal strings.

### Local mode

A long-lived process, such as an API server, a queue worker, or an agent runner, can spend from a
lease held in its own memory. Unprice debits the lease up front, and `authorize`, `settle`,
`release`, `charge`, and `spend` then answer in memory with the same contract and shapes, without
a network round trip. `record` and `get` still call the API.

```ts
const acme = unprice.budget("customer:acme", { mode: "local", lease: { amount: "5" } })

const text = await acme.spend({ estimate: maximumCost }, async () => {
  const r = await generateText({ model, prompt, maxOutputTokens })
  return { value: r.text, actual: costOf(r.usage) }
})

process.on("SIGTERM", () => void unprice.close())
```

The handle reports consumption every `flushIntervalMs` (1 second) and tops the lease back up to
`amount` in the background once it falls below `lowWater` (a quarter of `amount`). It renews the
lease once less than a third of `ttlMs` (60 seconds) is left, so `ttlMs` must exceed three flush
intervals; a shorter one throws a `RangeError`. Only a request the lease cannot cover waits for a
refill, and when the budget has no room left it gets the usual limit denial. When a new lease is
refused, the key's calls get that denial for `flushIntervalMs` before the handle asks again. If
Unprice cannot be reached, spending continues within the lease until its deadline; then
`authorize` and `charge` deny as `degraded`.

A client holds at most one lease per key. Every `unprice.budget(key, { mode: "local", ... })` call
on it spends from that lease, so taking a handle per request is fine. Taking one with other lease
options while the key's lease is open throws a `RangeError`. `onError` comes from the handle that
opened the lease.

A lease idle for `idleMs` (10 seconds) with no open hold goes back to Unprice: the handle sends
its final report, the unused capacity returns, and the next call takes a new lease in one round
trip. The client then keeps nothing for that key, so per-run keys such as `run:<id>` do not
accumulate. Pass `idleMs: Infinity` to keep the lease while the process runs.

Use local mode only in long-lived processes, and call `unprice.close()` before the process exits.
It sends each open lease's final report, which counts open holds at their full amount and returns
the rest of the lease. It resolves with a `{ key, error }` for each lease it could not return.
`acme.close()` does the same for one key. A process that crashes or never closes keeps its cap:
the lease expires after `ttlMs` (60 seconds) and counts in full, so that capacity stays used until
its window resets. Short-lived functions, such as serverless and edge handlers, should use the
default handle.

Local answers carry the balance from the last report, and their `crossed` is empty. Idempotency
keys replay for the life of the lease, up to its most recent 100,000 keys.

## License

MIT
