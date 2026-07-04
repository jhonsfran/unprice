import { describe, expect, it, vi } from "vitest"

const routerMocks = vi.hoisted(() => {
  const procedures = {
    applyTemplate: { name: "applyTemplate" },
    create: { name: "create" },
    deactivate: { name: "deactivate" },
    duplicate: { name: "duplicate" },
    getById: { name: "getById" },
    listByActiveProject: { name: "listByActiveProject" },
    listByProjectUnprice: { name: "listByProjectUnprice" },
    publish: { name: "publish" },
    remove: { name: "remove" },
    seedEvidence: { name: "seedEvidence" },
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

vi.mock("./applyTemplate", () => ({ applyTemplate: routerMocks.procedures.applyTemplate }))
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
vi.mock("./publish", () => ({ publish: routerMocks.procedures.publish }))
vi.mock("./remove", () => ({ remove: routerMocks.procedures.remove }))
vi.mock("./seedEvidence", () => ({ seedEvidence: routerMocks.procedures.seedEvidence }))
vi.mock("./update", () => ({ update: routerMocks.procedures.update }))

describe("plan versions router", () => {
  it("registers onboarding procedures under the plan version namespace", async () => {
    const { planVersionRouter } = await import("./index")
    const procedureKeys = Object.keys(planVersionRouter._def.procedures)

    expect(procedureKeys).toEqual(expect.arrayContaining(["applyTemplate", "seedEvidence"]))
    expect(procedureKeys).not.toContain("apply")
    expect(planVersionRouter._def.procedures.applyTemplate).toBe(
      routerMocks.procedures.applyTemplate
    )
    expect(planVersionRouter._def.procedures.seedEvidence).toBe(routerMocks.procedures.seedEvidence)
  })
})
