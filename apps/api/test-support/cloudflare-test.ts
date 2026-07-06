import { env } from "cloudflare:workers"

// Runtime-only modules provided by the Cloudflare Vitest workers pool.
// This repo is pinned to the Vitest 2-compatible pool release, which exposes
// the core DO helpers via `cloudflare:test-internal` but not `reset()`.
// @ts-expect-error runtime-only module
import {
  SELF,
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  createPagesEventContext,
  createScheduledController,
  fetchMock,
  getQueueResult,
  introspectWorkflow,
  introspectWorkflowInstance,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test-internal"
// @ts-expect-error runtime-only module
import workerdUnsafe from "workerd:unsafe"

type WorkerdUnsafeRuntime = {
  abortAllDurableObjects: () => Promise<void>
  evict?: (
    stub: DurableObjectStub,
    options?: { webSockets?: "close" | "hibernate" }
  ) => Promise<void>
}

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    /^(?:Loopback)?DurableObjectNamespace$/.test(value.constructor.name) &&
    "idFromName" in value &&
    typeof value.idFromName === "function" &&
    "get" in value &&
    typeof value.get === "function"
  )
}

async function clearNamespace(namespace: DurableObjectNamespace<unknown>) {
  const ids = await listDurableObjectIds(namespace)

  for (const id of ids) {
    const stub = namespace.get(id)
    await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
      await state.storage.deleteAlarm()
      await state.storage.deleteAll()
    })
  }
}

function getResettableNamespaces() {
  return [env.entitlementwindow, env.runbudget].filter(isDurableObjectNamespace)
}

export async function reset() {
  await workerdUnsafe.abortAllDurableObjects()
  await Promise.all(getResettableNamespaces().map((namespace) => clearNamespace(namespace)))
  await workerdUnsafe.abortAllDurableObjects()
}

export async function evictDurableObject(
  stub: DurableObjectStub,
  options: { webSockets?: "close" | "hibernate" } = { webSockets: "hibernate" }
) {
  const unsafeRuntime = workerdUnsafe as WorkerdUnsafeRuntime

  if (unsafeRuntime.evict) {
    await unsafeRuntime.evict(stub, options)
    return
  }

  await unsafeRuntime.abortAllDurableObjects()
}

export {
  SELF,
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  createPagesEventContext,
  createScheduledController,
  env,
  fetchMock,
  getQueueResult,
  introspectWorkflow,
  introspectWorkflowInstance,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
}
