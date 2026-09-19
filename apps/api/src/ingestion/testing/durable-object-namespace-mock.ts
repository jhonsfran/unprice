import { vi } from "vitest"

/**
 * Mock of a Durable Object namespace binding.
 *
 * Production code never touches a raw binding: it goes through
 * `ingestion/do-placement.ts`, which calls `jurisdiction()` and only then
 * `getByName()`. A hand-rolled mock that implements `getByName` alone fails
 * with `env.runbudget.jurisdiction is not a function`, thrown from inside the
 * client rather than from the test — so build namespace mocks here instead.
 *
 * `jurisdiction()` returns the same mock, which keeps `getByName` assertions
 * working whether or not the caller scoped first.
 */
export function createDurableObjectNamespaceMock<TStub>(stub: TStub) {
  const getByName = vi.fn(() => stub)
  const namespace: {
    getByName: typeof getByName
    jurisdiction: ReturnType<typeof vi.fn>
  } = {
    getByName,
    jurisdiction: vi.fn(() => namespace),
  }
  return namespace
}
