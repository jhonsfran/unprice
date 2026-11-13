import type { RouterOutputs } from "@unprice/trpc/routes"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AddFeatureCommandView } from "./add-feature-command"

type LibraryFeature = RouterOutputs["features"]["searchBy"]["features"][number]

const images = {
  id: "feat_images",
  projectId: "proj_1",
  slug: "images",
  title: "Images",
  description: "Generated images.",
  unitOfMeasure: "images",
  meterConfig: null,
  createdAtM: 0,
  updatedAtM: 0,
} as LibraryFeature

function render(query: string, features: LibraryFeature[], isLoading = false) {
  return renderToString(
    <AddFeatureCommandView
      query={query}
      onQueryChange={() => {}}
      features={features}
      isLoading={isLoading}
      onPick={() => {}}
      onCreate={() => {}}
    />
  ).replace(/<!-- -->/g, "")
}

/** `Create "Image gen"` as the markup escapes it. */
function createEntry(query: string): string {
  return `Create &quot;${query}&quot;`
}

describe("AddFeatureCommandView", () => {
  it("offers to create what was typed when nothing matches", () => {
    const html = render("Image gen", [])

    expect(html).toContain(createEntry("Image gen"))
    expect(html).toContain('value="Image gen"')
    expect(html.match(/cmdk-item=""/g)).toHaveLength(1)
  })

  it("lists a match by title and slug above the create entry", () => {
    const html = render("Ima", [images])

    expect(html).toContain("Images")
    expect(html).toContain("images")
    expect(html.indexOf("Images")).toBeLessThan(html.indexOf(createEntry("Ima")))
  })

  it("offers a plain create entry before anything is typed", () => {
    const html = render("", [])

    expect(html).toContain("Create a feature")
    expect(html).not.toContain("Create &quot;")
  })
})
