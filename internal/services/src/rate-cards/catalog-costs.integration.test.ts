import { eq } from "@unprice/db"
import { modelCosts as modelCostsTable } from "@unprice/db/schema"
import { customModelCostSchema } from "@unprice/db/validators"
import { formatAmount } from "@unprice/money"
import { describe, expect, it } from "vitest"
import { MODEL_CATALOG } from "../budgets/model-catalog"
import { modelCosts, usdCard } from "../pricing/fixtures"
import { catalogEffectiveFrom, importModelCosts, publishCostPlus } from "../use-cases/rate-cards"
import {
  MINUTE,
  NOW,
  createRateCardIntegrationFixture,
  gpt41,
  intervals,
  projectId,
  rejection,
  value,
} from "./service.integration.fixture"

describe("RateCardService catalog costs", () => {
  const { db, rateCards, services, createCard, publish, cardRows } =
    createRateCardIntegrationFixture()

  it("refuses a cost-plus draft whose open row was replaced after the preview", async () => {
    const card = await createCard({
      type: "costPlus",
      features: [
        {
          featureSlug: "llm_tokens",
          markup: "0.3",
          roundTo: "0.01",
          dimension: "model",
          componentMap: { input: "input_tokens", output: "output_tokens" },
        },
      ],
    })
    await value(publish(card.id, [gpt41("2.00", "8.00")], NOW))
    await rateCards.insertModelCosts([modelCosts.gpt41])
    const preview = await value(rateCards.previewCostPlus(projectId, card.id, NOW))
    await value(publish(card.id, [gpt41("9.00", "9.00")], NOW + 10 * MINUTE))
    const before = intervals(await cardRows(card.id))

    const stale = await rejection(
      publishCostPlus(
        { services },
        {
          projectId,
          cardId: card.id,
          effectiveFrom: NOW + 60 * MINUTE,
          draftHash: preview.draftHash,
          now: NOW + MINUTE,
        }
      )
    )

    expect(stale).toMatchObject({ code: "DRAFT_STALE" })
    expect(before).toEqual([
      [0, 10 * MINUTE, ["2", "8"]],
      [10 * MINUTE, null, ["9", "9"]],
    ])
    expect(intervals(await cardRows(card.id))).toEqual(before)
  })

  it("publishes a cost-plus revision past a model row scheduled to retire", async () => {
    const day = 24 * 60 * MINUTE
    const card = await createCard({
      type: "costPlus",
      features: [
        {
          featureSlug: "llm_tokens",
          markup: "0.3",
          roundTo: "0.01",
          dimension: "model",
          componentMap: { input: "input_tokens", output: "output_tokens" },
        },
      ],
    })
    const claude = { ...gpt41("3.00", "15.00"), match: { model: "claude-sonnet-4" } }
    const [gpt] = (await value(publish(card.id, [gpt41("2.60", "10.40"), claude], NOW))).inserted
    await value(
      rateCards.closeRows({
        projectId,
        cardId: card.id,
        rowIds: [gpt?.id ?? ""],
        effectiveTo: NOW + day,
        now: NOW,
      })
    )
    await rateCards.insertModelCosts([modelCosts.gpt41, modelCosts.claudeSonnet4])

    const preview = await value(rateCards.previewCostPlus(projectId, card.id, NOW + MINUTE))
    const published = await value(
      publishCostPlus(
        { services },
        {
          projectId,
          cardId: card.id,
          effectiveFrom: NOW + 20 * MINUTE,
          draftHash: preview.draftHash,
          now: NOW + MINUTE,
        }
      )
    )

    expect(preview.draft.changes.map((change) => [change.type, change.proposed.match])).toEqual([
      ["changed", { model: "claude-sonnet-4" }],
      ["retiring", { model: "gpt-4.1" }],
    ])
    expect([published.inserted.map((row) => row.match), published.unchanged]).toEqual([
      [{ model: "claude-sonnet-4" }],
      1,
    ])
    expect(
      (await cardRows(card.id))
        .map((row) => [
          row.match.model,
          row.effectiveFrom - NOW,
          row.effectiveTo === null ? null : row.effectiveTo - NOW,
        ])
        .sort()
    ).toEqual([
      ["claude-sonnet-4", 0, 20 * MINUTE],
      ["claude-sonnet-4", 20 * MINUTE, null],
      ["gpt-4.1", 0, day],
    ])
  })

  it("imports only changed catalog costs and never touches a manual cost", async () => {
    const day = 24 * 60 * MINUTE
    await db.insert(modelCostsTable).values([
      {
        id: "mc_haiku_current",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        components: { input: "1", output: "5", cache_read: "0.1", cache_write: "1.25" },
        effectiveFrom: NOW - day,
        source: "modelsdev",
        sourceRef: "2026-10-01",
      },
      {
        id: "mc_haiku_manual",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        components: { input: "0.5" },
        effectiveFrom: NOW - day,
        source: "manual",
        sourceRef: "negotiated",
      },
    ])

    const first = await importModelCosts({ services }, { effectiveFrom: NOW })
    const second = await importModelCosts({ services }, { effectiveFrom: NOW + day })
    const haiku = await db
      .select()
      .from(modelCostsTable)
      .where(eq(modelCostsTable.model, "claude-haiku-4-5"))

    expect(first).toEqual({ inserted: MODEL_CATALOG.length - 1, unchanged: 1 })
    expect(second).toEqual({ inserted: 0, unchanged: MODEL_CATALOG.length })
    expect(haiku.map((row) => [row.id, row.source, row.components]).sort()).toEqual([
      [
        "mc_haiku_current",
        "modelsdev",
        { input: "1", output: "5", cache_read: "0.1", cache_write: "1.25" },
      ],
      ["mc_haiku_manual", "manual", { input: "0.5" }],
    ])
  })

  it("imports the bundled catalog at its version date once, however many imports race", async () => {
    const effectiveFrom = catalogEffectiveFrom()

    const [first, second] = await Promise.all([
      importModelCosts({ services }, { effectiveFrom }),
      importModelCosts({ services }, { effectiveFrom }),
    ])
    const stored = await db.select().from(modelCostsTable)

    expect(first.inserted + second.inserted).toBe(MODEL_CATALOG.length)
    expect(stored).toHaveLength(MODEL_CATALOG.length)
    expect(new Set(stored.map((row) => row.effectiveFrom))).toEqual(
      new Set([Date.parse("2026-10-20T00:00:00.000Z")])
    )
  })

  it("drafts a project's own models at cost plus markup, over models.dev, from their start", async () => {
    const card = await createCard({
      type: "costPlus",
      features: [
        {
          featureSlug: "llm_tokens",
          markup: "0.3",
          roundTo: "0.01",
          dimension: "model",
          componentMap: { input: "input_tokens", output: "output_tokens" },
        },
      ],
    })
    await rateCards.insertModelCosts([modelCosts.gpt41])
    const custom = (model: string, input: string, effectiveFrom: number) =>
      rateCards.insertCustomModelCost(
        projectId,
        customModelCostSchema.parse({
          id: "unused",
          provider: "acme",
          model,
          components: { input, output: "2" },
          effectiveFrom,
        })
      )
    const llama = await custom("acme-llama-70b", "1", NOW - MINUTE)
    // A negotiated gpt-4.1 cost outranks the models.dev one; a later one waits for its start.
    await custom("gpt-4.1", "10", NOW - MINUTE)
    await custom("gpt-4.1", "20", NOW + MINUTE)

    const preview = await value(rateCards.previewCostPlus(projectId, card.id, NOW))
    const rates = (model: string) =>
      preview.draft.changes
        .find((change) => change.proposed.match.model === model)
        ?.proposed.price.components.map((c) => `${c.property}=${formatAmount(c.rate)}`)
    const listed = await rateCards.customModelCosts(projectId)

    expect(llama.id).toMatch(/^cmc_/)
    expect(rates("acme-llama-70b")).toEqual(["input_tokens=1.3", "output_tokens=2.6"])
    expect(rates("gpt-4.1")).toEqual(["input_tokens=13", "output_tokens=2.6"])
    expect(
      preview.draft.changes.find((change) => change.proposed.match.model === "acme-llama-70b")
        ?.proposed.sourceRef
    ).toBe(llama.id)
    expect(
      listed.map((cost) => [cost.model, formatAmount(cost.components.input ?? BigInt(0))])
    ).toEqual([
      ["acme-llama-70b", "1"],
      ["gpt-4.1", "20"],
    ])
  })

  it("previews cost-plus rates and publishes the reviewed draft as catalog rows", async () => {
    const card = await createCard({
      type: "costPlus",
      features: [
        {
          featureSlug: "llm_tokens",
          markup: "0.3",
          roundTo: "0.01",
          dimension: "model",
          componentMap: {
            input: "input_tokens",
            cache_read: "cached_input_tokens",
            output: "output_tokens",
            cache_write: "cache_write_tokens",
          },
        },
      ],
    })
    const tokenRows = usdCard.rows.filter((row) => row.featureSlug === "llm_tokens")
    await value(publish(card.id, tokenRows, NOW))
    await rateCards.insertModelCosts([modelCosts.gpt41, modelCosts.claudeSonnet4])
    const costIds = Object.fromEntries(
      (await db.select().from(modelCostsTable)).map((row) => [row.model, row.id])
    )

    const preview = await value(rateCards.previewCostPlus(projectId, card.id, NOW))
    const stale = await rejection(
      publishCostPlus(
        { services },
        { projectId, cardId: card.id, effectiveFrom: NOW + 10 * MINUTE, draftHash: "f00", now: NOW }
      )
    )
    const published = await value(
      publishCostPlus(
        { services },
        {
          projectId,
          cardId: card.id,
          effectiveFrom: NOW + 11 * MINUTE,
          draftHash: preview.draftHash,
          now: NOW + MINUTE,
        }
      )
    )

    expect(
      preview.draft.changes.map((change) => [
        change.type,
        change.proposed.match,
        change.proposed.price.components.map((c) => `${c.property}=${formatAmount(c.rate)}`),
      ])
    ).toEqual([
      [
        "changed",
        { model: "claude-sonnet-4" },
        [
          "input_tokens=3.9",
          "output_tokens=19.5",
          "cached_input_tokens=0.39",
          "cache_write_tokens=4.88",
        ],
      ],
      [
        "changed",
        { model: "gpt-4.1" },
        ["input_tokens=2.6", "output_tokens=10.4", "cached_input_tokens=0.65"],
      ],
    ])
    const retried = await value(
      publishCostPlus(
        { services },
        {
          projectId,
          cardId: card.id,
          effectiveFrom: NOW + 12 * MINUTE,
          draftHash: preview.draftHash,
          now: NOW + 2 * MINUTE,
        }
      )
    )

    expect(stale).toEqual({ code: "DRAFT_STALE", draftHash: preview.draftHash })
    expect(published.inserted.map((row) => [row.match.model, row.source, row.sourceRef])).toEqual([
      ["claude-sonnet-4", "catalog", costIds["claude-sonnet-4"]],
      ["gpt-4.1", "catalog", costIds["gpt-4.1"]],
    ])
    expect(published.closed.length).toBe(2)
    expect(retried).toEqual({ inserted: [], closed: [], unchanged: 2 })
    expect(
      (await cardRows(card.id)).map((row) => [
        row.match.model,
        row.source,
        row.effectiveFrom - NOW,
        row.effectiveTo === null ? null : row.effectiveTo - NOW,
      ])
    ).toEqual([
      ["gpt-4.1", "manual", 0, 11 * MINUTE],
      ["gpt-4.1-mini", "manual", 0, null],
      ["claude-sonnet-4", "manual", 0, 11 * MINUTE],
      ["claude-sonnet-4", "catalog", 11 * MINUTE, null],
      ["gpt-4.1", "catalog", 11 * MINUTE, null],
    ])
  })
})
