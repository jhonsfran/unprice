import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import {
  Harness,
  MemoryStorage,
  type ToolRegistration,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable"
import { Unprice } from "@unprice/budgets"
import { describe, expect, expectTypeOf, it } from "vitest"
import { withUnpriceTool } from "./tool"

const context = BACKGROUND_CONTEXT
const balance = { remaining: "1", held: "0", limits: [], asOf: 1_792_000_000_000 }

function fixture(status = 200) {
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const charges = new Map<string, string>()
  const order: string[] = []
  const client = new Unprice({
    token: "tool-test",
    retry: { attempts: 0 },
    fetch: async (request) => {
      const body: Record<string, unknown> = await request.json()
      requests.push({ path: new URL(request.url).pathname, body })
      order.push("charge")
      if (status !== 200) {
        return Response.json(
          {
            error: {
              code: "BUDGET_EXCEEDED",
              message: "Limit exceeded",
              docs: "",
              requestId: "tool-test",
            },
          },
          { status }
        )
      }
      if (typeof body.idempotencyKey !== "string" || typeof body.amount !== "string")
        throw new Error("Invalid charge request")
      const replayed = charges.has(body.idempotencyKey)
      charges.set(body.idempotencyKey, body.amount)
      return Response.json({ amount: body.amount, replayed, balance })
    },
  })
  const tool = defineTool({
    name: "weather",
    description: "Get the weather",
    parameters: Type.Object({ location: Type.String() }),
    replay: "safe",
    execute: async ({ location }) => {
      order.push("execute")
      return {
        output: [{ type: "text", text: `${location}: sunny` }],
        details: { location },
      }
    },
  })
  return { client, tool, requests, charges, order }
}

async function run(tool: ToolRegistration) {
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(tool.name, { location: "London" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Weather complete"),
  ])
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(defineExtension({ name: "priced-tools", tools: [tool] }))
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  try {
    const root = await harness.root(context)
    await root.configure({ model: { provider: "faux", modelId: "faux-1" }, tools: [tool] }, context)
    await (await root.submit({ type: "input", content: "Weather in London" }, context)).wait(
      context
    )
    await root.waitForIdle(context)
    return {
      usage: await harness.usage(context),
      results: (await root.context(context)).messages.filter(
        (message) => message.role === "toolResult"
      ),
    }
  } finally {
    await harness.close(context)
  }
}

describe("withUnpriceTool", () => {
  it("charges before execution and records a fixed fee through a real Pi tool task", async () => {
    const test = fixture()
    const weather = withUnpriceTool(test.tool, {
      amount: 0.01,
      getBudget: () => test.client.budget("customer:one"),
      sessionId: "session-one",
    })
    expectTypeOf<Parameters<typeof weather.execute>[0]>().toEqualTypeOf<{ location: string }>()
    expect(weather.parameters).toBe(test.tool.parameters)
    expect(weather.replay).toBe("safe")
    const result = await run(weather)
    expect(test.order).toEqual(["charge", "execute"])
    expect(test.requests).toEqual([
      {
        path: "/v1/budgets/charge",
        body: {
          key: "customer:one",
          amount: "0.01",
          idempotencyKey: expect.stringMatching(/^tool:session-one:\d+$/),
        },
      },
    ])
    expect(result.results).toMatchObject([
      {
        content: [{ type: "text", text: "London: sunny" }],
        details: { location: "London" },
      },
    ])
    expect(result.usage.tools.weather).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    })
  })

  it("keeps existing token usage and adds the fixed fee without mutating the tool result", async () => {
    const test = fixture()
    const usage = {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
      cost: { input: 0.1, output: 0.1, cacheRead: 0.025, cacheWrite: 0.025, total: 0.25 },
    }
    const original = { output: [{ type: "text" as const, text: "Measured result" }], usage }
    const weather = withUnpriceTool(
      { ...test.tool, execute: async () => original },
      {
        amount: 0.01,
        getBudget: () => test.client.budget("customer:one"),
        sessionId: "session-one",
      }
    )
    const result = await run(weather)
    expect(result.usage.tools.weather).toEqual({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
      cost: { input: 0.1, output: 0.1, cacheRead: 0.025, cacheWrite: 0.025, total: 0.26 },
    })
    expect(original.usage.cost.total).toBe(0.25)
  })

  it("reuses the task charge when execution replays", async () => {
    const test = fixture()
    const weather = withUnpriceTool(test.tool, {
      amount: 0.01,
      getBudget: () => test.client.budget("customer:one"),
      sessionId: "session-one",
    })
    const replay: typeof weather = {
      ...weather,
      execute: async (args, api, context) => {
        await weather.execute(args, api, context)
        return weather.execute(args, api, context)
      },
    }
    const result = await run(replay)
    expect(test.requests).toHaveLength(2)
    expect(test.requests[0]?.body.idempotencyKey).toBe(test.requests[1]?.body.idempotencyKey)
    expect([...test.charges.values()]).toEqual(["0.01"])
    expect(result.usage.tools.weather?.cost.total).toBe(0.01)
  })

  it("keeps task charge identities separate across sessions", async () => {
    const test = fixture()
    for (const sessionId of ["session-one", "session-two"]) {
      await run(
        withUnpriceTool(test.tool, {
          amount: "0.01",
          getBudget: () => test.client.budget("customer:one"),
          sessionId,
        })
      )
    }
    expect(test.charges.size).toBe(2)
  })

  it("blocks execution and reports no tool usage when the charge is denied", async () => {
    const test = fixture(409)
    const result = await run(
      withUnpriceTool(test.tool, {
        amount: 0.01,
        getBudget: () => test.client.budget("customer:one"),
        sessionId: "session-one",
      })
    )
    expect(test.order).toEqual(["charge"])
    expect(result.results).toMatchObject([{ isError: true }])
    expect(result.usage.tools).toEqual({})
  })

  it("uses the same decimal amount for the charge and Pi usage", async () => {
    const test = fixture()
    const result = await run(
      withUnpriceTool(test.tool, {
        amount: 0.1 + 0.2,
        getBudget: () => test.client.budget("customer:one"),
        sessionId: "session-one",
      })
    )
    expect(test.requests[0]?.body.amount).toBe("0.3")
    expect(result.usage.tools.weather?.cost.total).toBe(0.3)
  })

  it("blocks execution when budget resolution fails", async () => {
    const test = fixture()
    const result = await run(
      withUnpriceTool(test.tool, {
        amount: 0.01,
        getBudget: async () => {
          throw new Error("Budget unavailable")
        },
        sessionId: "session-one",
      })
    )
    expect(test.order).toEqual([])
    expect(result.results).toMatchObject([{ isError: true }])
    expect(result.usage.tools).toEqual({})
  })

  it("rejects local handles before charging or executing a durable tool", async () => {
    const test = fixture()
    const result = await run(
      withUnpriceTool(test.tool, {
        amount: "0.01",
        getBudget: () =>
          test.client.budget("customer:one", { mode: "local", lease: { amount: "1" } }),
        sessionId: "session-one",
      })
    )
    expect(test.requests).toEqual([])
    expect(test.order).toEqual([])
    expect(result.results).toMatchObject([
      { isError: true, content: [{ text: expect.stringContaining("remote budget handle") }] },
    ])
    expect(result.usage.tools).toEqual({})
  })

  it("keeps the attempt charge and propagates an execution failure", async () => {
    const test = fixture()
    const result = await run(
      withUnpriceTool(
        {
          ...test.tool,
          execute: async () => {
            throw new Error("Weather offline")
          },
        },
        {
          amount: 0.01,
          getBudget: () => test.client.budget("customer:one"),
          sessionId: "session-one",
        }
      )
    )
    expect([...test.charges.values()]).toEqual(["0.01"])
    expect(result.results).toMatchObject([
      { isError: true, content: [{ text: expect.stringContaining("Weather offline") }] },
    ])
  })

  it("includes the fee when a tool returns an error result", async () => {
    const test = fixture()
    const result = await run(
      withUnpriceTool(
        {
          ...test.tool,
          execute: async () => ({
            isError: true,
            output: [{ type: "text", text: "No forecast available" }],
          }),
        },
        {
          amount: 0.01,
          getBudget: () => test.client.budget("customer:one"),
          sessionId: "session-one",
        }
      )
    )
    expect(result.results).toMatchObject([{ isError: true }])
    expect(result.usage.tools.weather?.cost.total).toBe(0.01)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "invalid", ""])(
    "rejects an invalid fixed fee %s before making any budget request",
    (amount) => {
      const test = fixture()
      expect(() =>
        withUnpriceTool(test.tool, {
          amount,
          getBudget: () => test.client.budget("customer:one"),
          sessionId: "session-one",
        })
      ).toThrow(RangeError)
      expect(test.requests).toEqual([])
    }
  )
})
