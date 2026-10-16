import type { Ledger } from "@unprice/services/budgets"
import type { BudgetStore } from "./ports"

declare const store: BudgetStore

export const ledger: Ledger = store.atomically((tx) => tx.readLedger())

// @ts-expect-error a Promise-returning callback would let writes before its await commit alone
store.atomically(async (tx) => tx.readLedger())
