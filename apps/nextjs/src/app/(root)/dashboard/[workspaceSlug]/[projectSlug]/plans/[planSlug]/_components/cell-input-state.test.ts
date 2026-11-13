import { describe, expect, it } from "vitest"
import { cellCommitOf, cellEditReducer } from "./cell-input-state"

describe("cell edits", () => {
  it("starts each edit with the current saved value", () => {
    let edit = cellEditReducer(null, { type: "focus", value: "10" })
    edit = cellEditReducer(edit, { type: "change", value: "15" })
    expect(cellCommitOf(edit, "10", false)).toBe("15")
    edit = cellEditReducer(edit, { type: "blur" })
    expect(edit).toBeNull()

    expect(cellEditReducer(edit, { type: "focus", value: "20" })).toEqual({
      initial: "20",
      draft: "20",
    })
  })

  it("does not overwrite a sheet save or refetch that arrives during the edit", () => {
    const edit = cellEditReducer(cellEditReducer(null, { type: "focus", value: "10" }), {
      type: "change",
      value: "15",
    })

    expect(cellCommitOf(edit, "20", false)).toBeNull()
    expect(cellCommitOf(edit, "20", true)).toBeNull()
  })

  it("discards the draft on Escape, so the next edit uses saved props", () => {
    let edit = cellEditReducer(null, { type: "focus", value: "10" })
    edit = cellEditReducer(edit, { type: "change", value: "15" })
    edit = cellEditReducer(edit, { type: "blur" })

    expect(cellCommitOf(edit, "20", false)).toBeNull()
    expect(cellEditReducer(edit, { type: "focus", value: "20" })?.draft).toBe("20")
  })

  it("skips unchanged values unless the field needs a retry or its initial price", () => {
    const edit = cellEditReducer(null, { type: "focus", value: "0" })

    expect(cellCommitOf(edit, "0", false)).toBeNull()
    expect(cellCommitOf(edit, "0", true)).toBe("0")
  })
})
