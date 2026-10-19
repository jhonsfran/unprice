# @unprice/budgets

Hard caps for AI agents. A budget sits on any key you choose, such as a customer, a run, an agent,
or an API key. Each paid call asks the budget before it runs, and a call the cap cannot cover never
reaches the provider. Your billing stack does not change.

[`@unprice/api`](https://github.com/jhonsfran/unprice/tree/main/packages/api) includes this client
and re-exports its handles, errors, and types. Code moves between the two packages by changing the
import.

## Installation

```bash
pnpm add @unprice/budgets
```

## Example

Define the budget once, then wrap the paid call.

```ts
import { BudgetExceededError, Unprice } from "@unprice/budgets"

const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN! })

await unprice.budgets.upsert({
  key: "customer:acme",
  unit: "USD",
  limits: [{ amount: "50", window: "month" }],
})

try {
  const text = await unprice.budget("customer:acme").spend(
    { estimate: maximumCost, idempotencyKey: request.id },
    async () => {
      const r = await generateText({ model, prompt, maxOutputTokens })
      return { value: r.text, actual: costOf(r.usage) }
    }
  )
} catch (error) {
  if (error instanceof BudgetExceededError) console.log(error.blocked.remedy)
  else throw error
}
```

`spend` reserves `estimate`, runs your function, and settles `actual`, which may not exceed the
estimate. `maximumCost` and `costOf` come from your code. If the cap cannot cover the estimate,
`spend` throws `BudgetExceededError` and your function does not run.

## Documentation

- [Overview](https://docs.unprice.dev/budgets/overview)
- [Quickstart](https://docs.unprice.dev/budgets/quickstart)
- [Keys and limits](https://docs.unprice.dev/budgets/keys-and-limits): units, windows, closing a
  budget, and which key may raise a cap
- [Spend against a budget](https://docs.unprice.dev/budgets/spend): `spend`, `authorize`,
  `charge`, `record`, and settling in the background with `waitUntil`
- [Local mode](https://docs.unprice.dev/budgets/local-mode): answer checks from a lease in a
  long-lived process
- [Errors and recovery](https://docs.unprice.dev/budgets/errors): what each error means and how
  to recover
- [TypeScript SDK reference](https://docs.unprice.dev/budgets/sdk): operations, handles, and
  client options

## License

MIT
