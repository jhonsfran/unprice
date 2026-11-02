import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import Ajv from "ajv"
import addFormats from "ajv-formats"

const require = createRequire(import.meta.url)
const mintRequire = createRequire(require.resolve("mint/package.json"))
const cliRequire = createRequire(mintRequire.resolve("@mintlify/cli"))
const validation = await import(pathToFileURL(cliRequire.resolve("@mintlify/validation")))
const ajv = new Ajv({ strict: false, logger: false, allErrors: true })
addFormats(ajv)
const validateJson = ajv.compile(validation.docsConfigJsonSchema)
const fixture = {
  theme: "mint",
  name: "Example",
  colors: { primary: "#123456" },
  navigation: { groups: [{ group: "Guides", pages: ["index"] }] },
  footer: { socials: { github: "https://github.com/example" } },
}

// This normalized result is the output of the original v3 validator for the same fixture.
test("preserves config defaults and partial social records", () => {
  assert.deepEqual(validation.docsConfigSchema.parse(fixture), {
    ...fixture,
    $schema: "https://mintlify.com/docs.json",
  })
  assert.equal(validateJson(fixture), true, JSON.stringify(validateJson.errors))
})

test("validates the repository docs with both runtime and generated JSON schemas", () => {
  const docs = JSON.parse(readFileSync(new URL("../docs.json", import.meta.url), "utf8"))
  assert.equal(validation.validateDocsConfig(docs).success, true)
  assert.equal(validateJson(docs), true, JSON.stringify(validateJson.errors))
})

test("retains required fields, enum constraints, URLs, and nested navigation validation", () => {
  for (const invalid of [
    { ...fixture, name: undefined },
    { ...fixture, theme: "not-a-theme" },
    { ...fixture, colors: { primary: "not-a-color" } },
    { ...fixture, footer: { socials: { github: "not-a-url" } } },
    { ...fixture, footer: { socials: { unknown: "https://example.com" } } },
    { ...fixture, navigation: { groups: [{ group: "Guides", pages: [32] }] } },
  ]) {
    assert.equal(validation.docsConfigSchema.safeParse(invalid).success, false)
    assert.equal(validateJson(invalid), false)
  }
  assert.equal(validateJson({ ...fixture, unexpectedRootField: true }), false)
})

test("resolves recursive JSON schema references and formats union failures", () => {
  const nested = {
    ...fixture,
    navigation: { groups: [{ group: "Outer", pages: [{ group: "Inner", pages: ["index"] }] }] },
  }
  assert.equal(validation.docsConfigSchema.safeParse(nested).success, true)
  assert.equal(validateJson(nested), true, JSON.stringify(validateJson.errors))
  const result = validation.validateDocsConfig({ ...fixture, navigation: { groups: [42] } })
  assert.equal(result.success, false)
  for (const issue of result.error.issues)
    assert.equal(typeof validation.formatIssue(issue), "string")
})

test("keeps the legacy mint.json schema functional", () => {
  const config = {
    name: "Example",
    favicon: "/favicon.svg",
    colors: { primary: "#123456" },
    navigation: [{ group: "Guides", pages: ["index"] }],
  }
  assert.equal(validation.validateMintConfig(config).success, true)
  const validateLegacy = ajv.compile(validation.mintConfigJsonSchema)
  assert.equal(validateLegacy(config), true, JSON.stringify(validateLegacy.errors))
  assert.equal(validateLegacy({ ...config, colors: { primary: "bad" } }), false)
})

test(
  "scrapes rendered HTML with the upgraded Puppeteer",
  {
    skip: !process.env.PUPPETEER_EXECUTABLE_PATH,
  },
  async () => {
    const linkRequire = createRequire(cliRequire.resolve("@mintlify/link-rot"))
    const scrapingEntry = linkRequire.resolve("@mintlify/scraping")
    const scrapingRequire = createRequire(scrapingEntry)
    const { launch } = await import(pathToFileURL(scrapingRequire.resolve("puppeteer")))
    const { getHtmlWithPuppeteer } = await import(
      pathToFileURL(join(dirname(scrapingEntry), "utils/network.js"))
    )
    const browser = await launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: ["--no-sandbox"],
    })
    try {
      const html = await getHtmlWithPuppeteer(
        browser,
        new URL("data:text/html,<h1>Migration check</h1>")
      )
      assert.match(html, /<h1>Migration check<\/h1>/)
    } finally {
      await browser.close()
    }
  }
)
