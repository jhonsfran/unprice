// The Budgets snippets, shared by the /budgets page and the Budgets setup in the dashboard so
// both show the same two calls the README and the docs quickstart use.

export const BUDGETS_INSTALL = "npm i @unprice/budgets"

/**
 * The two calls. With a `token` the client line carries that key, so the snippet runs as pasted;
 * the comment above it tells the builder to move the key into `UNPRICE_TOKEN` before committing.
 */
export function budgetsTwoCalls(token?: string): string {
  const client = token
    ? `// Your runtime key. Move it to UNPRICE_TOKEN before you commit.
const unprice = new Unprice({ token: "${token}" })`
    : "const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN! })"

  return `import { Unprice } from "@unprice/budgets"

${client}

// 1. Set the cap once.
await unprice.budgets.upsert({
  key: "customer:acme",
  unit: "USD",
  limits: [{ amount: "50", window: "month" }],
})

// 2. Wrap the call your agent already makes.
const text = await unprice.budget("customer:acme").spend({ estimate }, async () => {
  const r = await generateText({ model, prompt, maxOutputTokens })
  return { value: r.text, actual: costOf(r.usage) }
})
`
}

export const BUDGETS_TWO_CALLS = budgetsTwoCalls()
