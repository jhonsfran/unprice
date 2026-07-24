import { describe, expect, it, vi } from "vitest"

const routerMocks = vi.hoisted(() => {
  const procedures = {
    create: { name: "create" },
    deactivate: { name: "deactivate" },
    duplicate: { name: "duplicate" },
    getById: { name: "getById" },
    listByActiveProject: { name: "listByActiveProject" },
    listByProjectUnprice: { name: "listByProjectUnprice" },
    provePaidAction: { name: "provePaidAction" },
    publish: { name: "publish" },
    remove: { name: "remove" },
    update: { name: "update" },
  }

  return {
    createTRPCRouter: vi.fn((procedureMap: Record<string, unknown>) => ({
      _def: {
        procedures: procedureMap,
      },
    })),
    procedures,
  }
})

vi.mock("#trpc", () => ({
  createTRPCRouter: routerMocks.createTRPCRouter,
}))

vi.mock("./create", () => ({ create: routerMocks.procedures.create }))
vi.mock("./deactivate", () => ({ deactivate: routerMocks.procedures.deactivate }))
vi.mock("./duplicate", () => ({ duplicate: routerMocks.procedures.duplicate }))
vi.mock("./getById", () => ({ getById: routerMocks.procedures.getById }))
vi.mock("./listByActiveProject", () => ({
  listByActiveProject: routerMocks.procedures.listByActiveProject,
}))
vi.mock("./listByProjectUnprice", () => ({
  listByProjectUnprice: routerMocks.procedures.listByProjectUnprice,
}))
vi.mock("./provePaidAction", () => ({ provePaidAction: routerMocks.procedures.provePaidAction }))
vi.mock("./publish", () => ({ publish: routerMocks.procedures.publish }))
vi.mock("./remove", () => ({ remove: routerMocks.procedures.remove }))
vi.mock("./update", () => ({ update: routerMocks.procedures.update }))

describe("plan versions router", () => {
  it("registers the paid-action proof procedure under the plan version namespace", async () => {
    const { planVersionRouter } = await import("./index")
    const procedureKeys = Object.keys(planVersionRouter._def.procedures)

    expect(procedureKeys).toEqual(expect.arrayContaining(["provePaidAction"]))
    expect(procedureKeys).not.toContain("seedEvidence")
    expect(procedureKeys).not.toContain("applyTemplate")
    expect(planVersionRouter._def.procedures.provePaidAction).toBe(
      routerMocks.procedures.provePaidAction
    )
  })
})
