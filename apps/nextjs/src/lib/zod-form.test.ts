import { useForm } from "react-hook-form"
import { beforeEach, expect, it, vi } from "vitest"
import { z } from "zod"
import { useZodForm } from "./zod-form"

vi.mock("react-hook-form", () => ({ useForm: vi.fn(() => ({})) }))
beforeEach(() => vi.clearAllMocks())

const schema = z.object({
  quantity: z.coerce.number().int().min(1),
  name: z.string().trim().min(1),
})

it("submits parsed values while retaining normalized form-state types", async () => {
  useZodForm({ schema, defaultValues: { quantity: 1, name: "Example" } })
  const resolver = vi.mocked(useForm).mock.calls[0]?.[0]?.resolver
  expect(resolver).toBeDefined()
  const result = await resolver?.({ quantity: "2", name: " Example " }, undefined, {
    shouldUseNativeValidation: false,
    fields: {},
  })
  expect(result).toEqual({ errors: {}, values: { quantity: 2, name: "Example" } })
})

it("returns field errors without submitting invalid values", async () => {
  useZodForm({ schema })
  const resolver = vi.mocked(useForm).mock.calls[0]?.[0]?.resolver
  const result = await resolver?.({ quantity: "0", name: " " }, undefined, {
    shouldUseNativeValidation: false,
    fields: {},
  })
  expect(result?.values).toEqual({})
  expect(result?.errors).toMatchObject({
    quantity: { type: "too_small" },
    name: { type: "too_small" },
  })
})
