import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { type Api, type Model, Type } from "@earendil-works/pi-ai"
import { type Provider, createModels } from "@earendil-works/pi-ai/models"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import {
  CompactionEntry,
  type ConversationHandle,
  Harness,
  MemoryStorage,
  type ToolRegistration,
  configure,
  createRegistry,
  defineExtension,
} from "@earendil-works/pi-durable"
import { Unprice } from "@unprice/budgets"
import { describe, expect, it } from "vitest"
import { withUnpriceBudget } from "./index"

const context = BACKGROUND_CONTEXT
const budgetKey = "test:customer:one"
const model: Model<"openai-responses"> = {
  id: "budget-harness",
  name: "Budget harness",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://provider.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 100_000,
  maxTokens: 8192,
}
const modelRef = { provider: model.provider, modelId: model.id }
type Reply = { text: string } | { tool: string }
type BudgetRequest = { path: string; body: Record<string, unknown> }

function responseStream(reply: Reply, sequence: number): Response {
  const item =
    "text" in reply
      ? {
          type: "message",
          id: `msg_${sequence}`,
          role: "assistant",
          content: [{ type: "output_text", text: reply.text, annotations: [] }],
        }
      : {
          type: "function_call",
          id: `fc_${sequence}`,
          call_id: `call_${sequence}`,
          name: reply.tool,
          arguments: "{}",
        }
  const events = [
    { type: "response.created", response: { id: `resp_${sequence}` } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${sequence}`,
        status: "completed",
        service_tier: "default",
        output: [item],
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
          input_tokens_details: { cached_tokens: 20 },
        },
      },
    },
  ]
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

async function fixture(
  replies: Reply[],
  tools: ToolRegistration[] = [],
  missingOwner = false,
  capacity?: string
) {
  const order: string[] = []
  const budgetRequests: BudgetRequest[] = []
  const providerPayloads: Record<string, unknown>[] = []
  const held = new Map<string, number>()
  let deny = false
  let generationCount = 0
  const client = new Unprice({
    token: "test-token",
    retry: { attempts: 0 },
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      const body = (await request.json()) as Record<string, unknown>
      budgetRequests.push({ path, body })
      if (path.endsWith("/authorize")) {
        order.push("authorize")
        if (deny || (capacity !== undefined && Number(body.amount) > Number(capacity)))
          return Response.json(
            {
              error: {
                code: "BUDGET_EXCEEDED",
                message: "Limit exceeded",
                docs: "",
                requestId: "test",
                details: {
                  kind: "budget_exceeded",
                  blocked: {
                    limitId: "day",
                    window: "day",
                    remaining: capacity ?? "0",
                    held: "0",
                    resetsAt: Date.now() + 1000,
                    remedy: "wait_for_reset",
                  },
                  balance: { remaining: capacity ?? "0", held: "0", limits: [] },
                },
              },
            },
            { status: 409 }
          )
        const holdId = `hold_${held.size + 1}`
        held.set(holdId, Number(body.amount))
        return Response.json({
          holdId,
          amount: body.amount,
          expiresAt: Date.now() + 300_000,
          replayed: false,
          balance: { remaining: "1", held: body.amount, limits: [] },
        })
      }
      if (path.endsWith("/settle")) {
        order.push("settle")
        if (typeof body.holdId !== "string" || Number(body.amount) > (held.get(body.holdId) ?? 0))
          throw new Error("Settlement exceeds the hold")
      }
      return Response.json({})
    },
  })
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    expect(request.headers.get("authorization")).toBe("Bearer sk-test")
    if (new URL(request.url).pathname.endsWith("/input_tokens")) {
      order.push("count")
      return Response.json({ object: "response.input_tokens", input_tokens: 20 })
    }
    order.push("generate")
    providerPayloads.push((await request.json()) as Record<string, unknown>)
    const reply = replies[generationCount++]
    if (reply === undefined) throw new Error("No model response fixture remains")
    return responseStream(reply, generationCount)
  }
  const budgeted = withUnpriceBudget(openaiProvider(), {
    getBudget: () => {
      if (missingOwner) throw new Error("Session has no budget owner")
      return client.budget(budgetKey)
    },
  })
  const provider: Provider = {
    ...budgeted,
    baseUrl: model.baseUrl,
    getModels: () => [model],
    getAllModels: () => [model],
    stream: (model, context, options) =>
      budgeted.stream<Api>(model, context, { ...options, fetch }),
    streamSimple: (model, context, options) =>
      budgeted.streamSimple(model, context, { ...options, fetch }),
  }
  const models = createModels({
    authContext: {
      env: async (name) => (name === "OPENAI_API_KEY" ? "sk-test" : undefined),
      fileExists: async () => false,
    },
  })
  models.setProvider(provider)
  const registry = createRegistry()
  registry.install(defineExtension({ name: "budget-test", tools }))
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: {
        retry: { enabled: false, maxRetries: 0 },
        compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 4096 },
        documentRetentionMs: 0,
        contextRetentionMs: 0,
      },
    },
    context
  )
  return {
    harness,
    models,
    order,
    budgetRequests,
    providerPayloads,
    deny: () => {
      deny = true
    },
  }
}

async function ask(conversation: ConversationHandle, content: string) {
  const result = await (await conversation.submit({ type: "input", content }, context)).wait(
    context
  )
  await conversation.waitForIdle(context)
  return result
}

describe("Unprice budget through Pi AI and Pi Durable", () => {
  it("counts and shrinks a denied request through the native provider", async () => {
    const test = await fixture([{ text: "Affordable reply" }], [], false, "0.001")
    try {
      const message = await test.models.complete(model, {
        messages: [{ role: "user", content: "Hello", timestamp: 0 }],
      })
      expect(message).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "Affordable reply" }],
      })
      expect(test.order).toEqual(["authorize", "count", "authorize", "generate", "settle"])
      expect(test.providerPayloads).toHaveLength(1)
      expect(test.providerPayloads[0]).toMatchObject({
        model: "budget-harness",
        max_output_tokens: 487,
        stream: true,
      })
      expect(
        test.budgetRequests.filter((request) => request.path.endsWith("/authorize")).at(-1)?.body
          .amount
      ).toBe("0.000999")
      expect(
        test.budgetRequests.filter((request) => request.path.endsWith("/settle"))
      ).toHaveLength(1)
    } finally {
      await test.harness.close(context)
    }
  })

  it.each(["stream", "streamSimple", "complete", "completeSimple"] as const)(
    "gates Models.%s through the actual OpenAI adapter",
    async (method) => {
      const test = await fixture([{ text: "Models reply" }])
      try {
        const input = { messages: [{ role: "user" as const, content: "Hello", timestamp: 0 }] }
        const result = test.models[method](model, input)
        const message = "result" in result ? await result.result() : await result
        expect(message).toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: "Models reply" }],
        })
        expect(test.order).toEqual(["authorize", "generate", "settle"])
      } finally {
        await test.harness.close(context)
      }
    }
  )

  it("settles an ordinary Harness generation before its submission completes", async () => {
    const test = await fixture([{ text: "Harness reply" }])
    try {
      const root = await test.harness.root(context)
      await root.configure({ model: modelRef }, context)
      expect(await ask(root, "Hello")).toMatchObject({ status: "done", type: "input" })
      expect(test.order).toEqual(["authorize", "generate", "settle"])
      expect((await root.context(context)).messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Harness reply" }],
      })
      expect(
        (await test.harness.usage(context)).models["openai/budget-harness"]?.cost.total
      ).toBeCloseTo(0.000102, 10)
    } finally {
      await test.harness.close(context)
    }
  })

  it("settles manual compaction and places the returned summary submission", async () => {
    const test = await fixture([
      { text: "First answer" },
      { text: "Second answer" },
      { text: "Budgeted summary" },
    ])
    try {
      const root = await test.harness.root(context)
      await root.configure({ model: modelRef }, context)
      await ask(root, "First question about project requirements")
      await ask(root, "Second question about the implementation")
      test.order.length = 0
      const task = await root.compact(undefined, context)
      const {
        state: { outcome },
      } = await test.harness.waitForTask(task, context)
      expect(outcome.status).toBe("completed")
      if (outcome.status !== "completed" || outcome.result.submissionId === undefined)
        throw new Error("Compaction did not return its summary submission")
      const submission = await test.harness.submission(outcome.result.submissionId, context)
      if (submission === undefined) throw new Error("Summary submission is missing")
      expect(await submission.wait(context)).toMatchObject({ type: "write", status: "done" })
      await root.waitForIdle(context)
      const summary = (await root.context(context)).entries.find(CompactionEntry.is)
      expect(summary?.model?.[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: expect.stringContaining("Budgeted summary") }],
      })
      expect(test.order).toEqual(["authorize", "generate", "settle"])
      expect(
        (await test.harness.usage(context)).models["openai/budget-harness"]?.cost.total
      ).toBeCloseTo(0.000306, 10)
    } finally {
      await test.harness.close(context)
    }
  })

  it("denies manual compaction before its model generation", async () => {
    const test = await fixture([{ text: "First answer" }, { text: "Second answer" }])
    try {
      const root = await test.harness.root(context)
      await root.configure({ model: modelRef }, context)
      await ask(root, "First question about project requirements")
      await ask(root, "Second question about the implementation")
      test.order.length = 0
      test.deny()
      const outcome = await test.harness.waitForTask(
        await root.compact(undefined, context),
        context
      )
      expect(outcome.state.outcome).toMatchObject({
        status: "failed",
        error: { message: expect.stringContaining("budget cannot cover") },
      })
      expect(test.order).toEqual(["authorize"])
      expect(test.providerPayloads).toHaveLength(2)
      expect((await root.context(context)).entries.some(CompactionEntry.is)).toBe(false)
    } finally {
      await test.harness.close(context)
    }
  })

  it("shares one budget across a task-owned child while using distinct holds", async () => {
    const delegate: ToolRegistration = {
      name: "delegate",
      description: "Ask a child conversation",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api, context) => {
        const childId = await api.commit(async (tx) => {
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: api.taskId },
          })
          await configure(tx, child.id, { model: modelRef, tools: [] })
          return child.id
        }, context)
        const child = await api.conversation(childId, context)
        if (child === undefined) throw new Error("Child conversation is missing")
        const result = await ask(child, "Answer as the child")
        if (result.status !== "done") throw new Error("Child did not answer")
        return {
          output: [{ type: "text", text: "Child completed" }],
          details: { conversationId: childId },
        }
      },
    }
    const test = await fixture(
      [{ tool: "delegate" }, { text: "Child answer" }, { text: "Parent answer" }],
      [delegate]
    )
    try {
      const root = await test.harness.root(context)
      await root.configure({ model: modelRef, tools: [delegate] }, context)
      expect(await ask(root, "Ask a child")).toMatchObject({ status: "done" })
      expect(test.order).toEqual(
        Array.from({ length: 3 }, () => ["authorize", "generate", "settle"]).flat()
      )
      const authorizations = test.budgetRequests.filter(({ path }) => path.endsWith("/authorize"))
      const settlements = test.budgetRequests.filter(({ path }) => path.endsWith("/settle"))
      expect(authorizations.map(({ body }) => body.key)).toEqual([budgetKey, budgetKey, budgetKey])
      expect(settlements.map(({ body }) => body.holdId)).toEqual(["hold_1", "hold_2", "hold_3"])
      expect(new Set(authorizations.map(({ body }) => body.idempotencyKey)).size).toBe(3)
      const children = await test.harness.commit(
        (tx) => tx.scanConversations({ ownerConversationId: root.id }, 10),
        context
      )
      expect(children.items).toHaveLength(1)
      expect(
        (await test.harness.usage(context)).models["openai/budget-harness"]?.cost.total
      ).toBeCloseTo(0.000306, 10)
    } finally {
      await test.harness.close(context)
    }
  })

  it("blocks a Harness generation when its budget owner is missing", async () => {
    const test = await fixture([], [], true)
    try {
      const root = await test.harness.root(context)
      await root.configure({ model: modelRef }, context)
      const result = await ask(root, "Hello")
      expect(result.status).toBe("unanswered")
      expect(test.order).toEqual([])
      expect(test.providerPayloads).toEqual([])
    } finally {
      await test.harness.close(context)
    }
  })
})
