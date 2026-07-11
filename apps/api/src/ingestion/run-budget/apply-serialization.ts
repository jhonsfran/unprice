/** Adapter-level serialization used by the Durable Object apply forwarding path. */
export function serializeRunBudgetApply<T>(
  state: Pick<DurableObjectState, "blockConcurrencyWhile">,
  apply: () => Promise<T>
): Promise<T> {
  return state.blockConcurrencyWhile(apply)
}
