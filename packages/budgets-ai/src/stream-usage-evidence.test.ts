import { describe, expect, it } from "vitest"
import { createStreamUsageEvidence } from "./stream-usage-evidence"

const anthropicStart = {
  type: "message_start",
  message: {
    usage: {
      input_tokens: 8,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 2,
      output_tokens: 0,
    },
  },
}
const anthropicText = {
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: "Hello" },
}
const anthropicFinal = {
  type: "message_delta",
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: 4 },
}
const anthropicStop = { type: "message_stop" }

const googleText = {
  candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Hello" }] } }],
}
const googleStop = { candidates: [{ index: 0, finishReason: "STOP" }] }
const googleUsage = {
  promptTokenCount: 8,
  candidatesTokenCount: 4,
  thoughtsTokenCount: 2,
  cachedContentTokenCount: 3,
  totalTokenCount: 14,
}
const googleFinal = { ...googleStop, usageMetadata: googleUsage }

function observeAnthropic(...events: unknown[]) {
  const evidence = createStreamUsageEvidence("anthropic-messages")
  for (const event of events) evidence.observe(event)
  return evidence
}

function observeGoogle(...chunks: unknown[]) {
  const evidence = createStreamUsageEvidence("google-generative-ai")
  for (const chunk of chunks) evidence.observe(chunk)
  return evidence
}

describe("Anthropic stream usage evidence", () => {
  it("does not treat preliminary input and generated text as final usage", () => {
    const evidence = observeAnthropic(anthropicStart, anthropicText, anthropicStop)
    expect(evidence.isComplete).toBe(false)
    evidence.observe(anthropicFinal)
    expect(evidence.isComplete).toBe(false)
  })

  it("requires final output usage and message_stop before completion", () => {
    const evidence = observeAnthropic(anthropicStart, anthropicText)
    expect(evidence.isComplete).toBe(false)
    evidence.observe(anthropicFinal)
    expect(evidence.isComplete).toBe(false)
    evidence.observe(anthropicStop)
    expect(evidence.isComplete).toBe(true)
  })

  it("does not treat an output usage update without a stop reason as final", () => {
    const evidence = observeAnthropic(
      anthropicStart,
      { type: "message_delta", delta: {}, usage: { output_tokens: 4 } },
      anthropicStop
    )
    expect(evidence.isComplete).toBe(false)
  })

  it("accepts zero final output tokens and optional initial cache counters", () => {
    const evidence = observeAnthropic(
      { type: "message_start", message: { usage: { input_tokens: 8 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
      anthropicStop
    )
    expect(evidence.isComplete).toBe(true)
  })

  it.each([
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    anthropicText,
    { type: "content_block_stop", index: 0 },
    { type: "error", error: { type: "overloaded_error", message: "Unavailable" } },
  ])("permanently rejects events after final usage %j", (event) => {
    const evidence = observeAnthropic(anthropicStart, anthropicFinal, event, anthropicStop)
    expect(evidence.isComplete).toBe(false)
    evidence.observe(anthropicFinal)
    evidence.observe(anthropicStop)
    expect(evidence.isComplete).toBe(false)
  })

  it.each([
    anthropicText,
    { type: "error", error: { type: "api_error", message: "Failed" } },
    anthropicStart,
  ])("invalidates completed evidence after a later event %j", (event) => {
    const evidence = observeAnthropic(anthropicStart, anthropicFinal, anthropicStop)
    expect(evidence.isComplete).toBe(true)
    evidence.observe(event)
    expect(evidence.isComplete).toBe(false)
    evidence.observe(anthropicFinal)
    evidence.observe(anthropicStop)
    expect(evidence.isComplete).toBe(false)
  })

  it("rejects duplicate message starts permanently", () => {
    const evidence = observeAnthropic(anthropicStart, anthropicStart, anthropicFinal, anthropicStop)
    expect(evidence.isComplete).toBe(false)
  })

  it.each([undefined, null, -1, 0.5, "4", Number.POSITIVE_INFINITY])(
    "rejects malformed final output usage %s permanently",
    (output_tokens) => {
      const evidence = observeAnthropic(anthropicStart, {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens },
      })
      evidence.observe(anthropicFinal)
      evidence.observe(anthropicStop)
      expect(evidence.isComplete).toBe(false)
    }
  )

  it("rejects a later delta that overwrites final output usage with zero", () => {
    const evidence = observeAnthropic(
      anthropicStart,
      { ...anthropicFinal, usage: { output_tokens: 1000 } },
      { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 0 } },
      anthropicStop
    )
    expect(evidence.isComplete).toBe(false)
  })

  it("rejects a delta before message_start even without a stop reason", () => {
    const evidence = observeAnthropic(
      { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 0 } },
      anthropicStart,
      anthropicFinal,
      anthropicStop
    )
    expect(evidence.isComplete).toBe(false)
  })

  it("accepts increasing cumulative output deltas and retains the terminal reason", () => {
    const evidence = observeAnthropic(
      anthropicStart,
      anthropicText,
      { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 2 } },
      { type: "message_delta", delta: {}, usage: { output_tokens: 4 } },
      { ...anthropicFinal, usage: { output_tokens: 6 } },
      { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 7 } }
    )
    expect(evidence.isComplete).toBe(false)
    evidence.observe(anthropicStop)
    expect(evidence.isComplete).toBe(true)
  })

  it("rejects a decrease in cumulative output before the terminal delta permanently", () => {
    const evidence = observeAnthropic(
      anthropicStart,
      { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 2 } },
      { type: "message_delta", delta: {}, usage: { output_tokens: 1 } },
      anthropicFinal,
      anthropicStop
    )
    expect(evidence.isComplete).toBe(false)
  })

  it("does not let pings alter complete usage evidence", () => {
    const evidence = observeAnthropic(
      { type: "ping" },
      anthropicStart,
      anthropicFinal,
      anthropicStop,
      { type: "ping" }
    )
    expect(evidence.isComplete).toBe(true)
  })
})

describe("Google stream usage evidence", () => {
  it("ignores early usage when more text and STOP arrive without final usage", () => {
    const evidence = observeGoogle(
      { ...googleText, usageMetadata: googleUsage },
      googleText,
      googleStop
    )
    expect(evidence.isComplete).toBe(false)
  })

  it("accepts usage in the same chunk as final text and STOP", () => {
    const evidence = observeGoogle({
      candidates: [{ ...googleText.candidates[0], finishReason: "STOP" }],
      usageMetadata: googleUsage,
    })
    expect(evidence.isComplete).toBe(true)
  })

  it("accepts final usage after early usage and more generated text", () => {
    const evidence = observeGoogle(
      { ...googleText, usageMetadata: { promptTokenCount: 8, totalTokenCount: 8 } },
      googleText,
      googleFinal
    )
    expect(evidence.isComplete).toBe(true)
  })

  it("accepts a separate usage-only chunk after STOP", () => {
    const evidence = observeGoogle(googleText, googleStop)
    expect(evidence.isComplete).toBe(false)
    evidence.observe({ usageMetadata: googleUsage })
    expect(evidence.isComplete).toBe(true)
  })

  it("rejects text after final usage permanently", () => {
    const evidence = observeGoogle(googleFinal)
    expect(evidence.isComplete).toBe(true)
    evidence.observe(googleText)
    expect(evidence.isComplete).toBe(false)
    evidence.observe(googleFinal)
    expect(evidence.isComplete).toBe(false)
  })

  it("rejects text after STOP even when usage arrives later", () => {
    const evidence = observeGoogle(googleStop, googleText, { usageMetadata: googleUsage })
    expect(evidence.isComplete).toBe(false)
  })

  it.each([
    { error: { code: 500, message: "Unavailable" } },
    { candidates: [{ continuationToken: "continue" }] },
    {
      candidates: [{ finishReason: "STOP", continuationToken: "continue" }],
      usageMetadata: googleUsage,
    },
  ])("invalidates errors and continuation permanently %j", (chunk) => {
    const evidence = observeGoogle(googleText, chunk, googleFinal)
    expect(evidence.isComplete).toBe(false)
  })

  it.each([
    { error: { code: 500, message: "Unavailable" } },
    { candidates: [{ continuationToken: "continue" }] },
    { candidates: [{ finishReason: "MAX_TOKENS" }] },
  ])("invalidates completed usage after an error or continuation %j", (chunk) => {
    const evidence = observeGoogle(googleFinal)
    expect(evidence.isComplete).toBe(true)
    evidence.observe(chunk)
    evidence.observe(googleFinal)
    expect(evidence.isComplete).toBe(false)
  })

  it.each([
    null,
    [],
    {},
    { ...googleUsage, promptTokenCount: undefined },
    { ...googleUsage, promptTokenCount: -1 },
    { ...googleUsage, candidatesTokenCount: 0.5 },
    { ...googleUsage, thoughtsTokenCount: "2" },
    { ...googleUsage, cachedContentTokenCount: 9 },
    { ...googleUsage, totalTokenCount: undefined },
    { ...googleUsage, totalTokenCount: 13 },
    { ...googleUsage, totalTokenCount: Number.POSITIVE_INFINITY },
    { ...googleUsage, toolUsePromptTokenCount: 1 },
  ])("rejects malformed final usage and totals permanently %j", (usageMetadata) => {
    const evidence = observeGoogle({ ...googleStop, usageMetadata })
    expect(evidence.isComplete).toBe(false)
    evidence.observe(googleFinal)
    expect(evidence.isComplete).toBe(false)
  })

  it("rejects a final output count overwritten with zero permanently", () => {
    const evidence = observeGoogle({
      ...googleStop,
      usageMetadata: { ...googleUsage, candidatesTokenCount: 1000, totalTokenCount: 1010 },
    })
    expect(evidence.isComplete).toBe(true)
    evidence.observe({
      usageMetadata: { ...googleUsage, candidatesTokenCount: 0, totalTokenCount: 10 },
    })
    expect(evidence.isComplete).toBe(false)
    evidence.observe({
      usageMetadata: { ...googleUsage, candidatesTokenCount: 2000, totalTokenCount: 2010 },
    })
    expect(evidence.isComplete).toBe(false)
  })

  it("accepts identical and increasing final usage snapshots", () => {
    const evidence = observeGoogle(googleFinal)
    evidence.observe({ usageMetadata: googleUsage })
    expect(evidence.isComplete).toBe(true)
    evidence.observe({
      usageMetadata: {
        promptTokenCount: 9,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 3,
        cachedContentTokenCount: 4,
        totalTokenCount: 17,
      },
    })
    expect(evidence.isComplete).toBe(true)
  })

  it.each([
    { ...googleUsage, promptTokenCount: 7, candidatesTokenCount: 6, totalTokenCount: 15 },
    { ...googleUsage, candidatesTokenCount: 3, promptTokenCount: 10, totalTokenCount: 15 },
    { ...googleUsage, thoughtsTokenCount: 1, promptTokenCount: 10, totalTokenCount: 15 },
    { ...googleUsage, cachedContentTokenCount: 2 },
  ])("rejects decreases in individual cumulative counters permanently %j", (usageMetadata) => {
    const evidence = observeGoogle(googleFinal, { usageMetadata }, googleFinal)
    expect(evidence.isComplete).toBe(false)
  })

  it("rejects final usage without an explicit output count", () => {
    const evidence = observeGoogle({
      ...googleStop,
      usageMetadata: { promptTokenCount: 8, totalTokenCount: 8 },
    })
    expect(evidence.isComplete).toBe(false)
    evidence.observe(googleFinal)
    expect(evidence.isComplete).toBe(false)
  })

  it("accepts zero output counts when the final total equals the prompt count", () => {
    const evidence = observeGoogle({
      ...googleStop,
      usageMetadata: {
        promptTokenCount: 8,
        candidatesTokenCount: 0,
        totalTokenCount: 8,
        toolUsePromptTokenCount: 0,
      },
    })
    expect(evidence.isComplete).toBe(true)
  })
})
