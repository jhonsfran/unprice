import { describe, expect, it } from "vitest"

import { getValidSubdomain } from "./domains"

describe("getValidSubdomain", () => {
  it("does not classify Vercel deployment hostnames as custom site domains", () => {
    expect(getValidSubdomain("unprice-m5my0x611-jhoan-francos-projects.vercel.app")).toBeNull()
  })

  it("keeps custom domains eligible for site routing", () => {
    expect(getValidSubdomain("customer.example")).toBe("customer.example")
  })
})
