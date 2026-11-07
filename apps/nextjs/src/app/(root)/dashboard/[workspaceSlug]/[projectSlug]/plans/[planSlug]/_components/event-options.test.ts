import { describe, expect, it } from "vitest"
import { eventCreateOption, eventMatches } from "./event-options"

const vectorQuery = { name: "Vector query", slug: "vector_query", availableProperties: [] }
const completion = {
  name: "AI completion",
  slug: "ai_completion",
  availableProperties: ["input_tokens"],
}

describe("eventCreateOption", () => {
  it("offers to create what was typed, with the slug the SDK will use", () => {
    expect(eventCreateOption("Vector query", [completion])).toEqual({
      name: "Vector query",
      slug: "vector_query",
      label: "Create event “Vector query” (slug vector_query)",
    })
    expect(eventCreateOption("  Image jobs ", [])?.label).toBe(
      "Create event “Image jobs” (slug image_jobs)"
    )
  })

  it("offers nothing before anything is typed", () => {
    expect(eventCreateOption("", [completion])).toBeNull()
    expect(eventCreateOption("   ", [])).toBeNull()
  })

  it("offers nothing when an event already carries that name or slug", () => {
    expect(eventCreateOption("vector query", [vectorQuery])).toBeNull()
    expect(eventCreateOption("vector_query", [vectorQuery])).toBeNull()
    expect(eventCreateOption("Vector queries", [vectorQuery])?.slug).toBe("vector_queries")
  })

  it("offers nothing the slug rule refuses", () => {
    expect(eventCreateOption("x".repeat(65), [])).toBeNull()
    expect(eventCreateOption("¿qué?", [])).toBeNull()
  })
})

describe("eventMatches", () => {
  it("matches the name, the slug, or a property, ignoring case", () => {
    expect(eventMatches("vector", vectorQuery)).toBe(true)
    expect(eventMatches("VECTOR_Q", vectorQuery)).toBe(true)
    expect(eventMatches("input_tok", completion)).toBe(true)
    expect(eventMatches("vector", completion)).toBe(false)
    expect(eventMatches("", completion)).toBe(true)
  })
})
