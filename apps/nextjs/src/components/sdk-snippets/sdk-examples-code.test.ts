import { globSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { METHOD_ORDER, type SDKExampleParams, getCodeExample } from "./sdk-examples-code"

const root = resolve(__dirname, "../../../../..")

function checkExamples(examples: { label: string; code: string }[]) {
  const files = new Map<string, string>()
  for (const [index, example] of examples.entries()) {
    const source = ts.createSourceFile("example.ts", example.code, ts.ScriptTarget.Latest, true)
    const imports = source.statements.filter(ts.isImportDeclaration)
    const body = source.statements.filter((statement) => !ts.isImportDeclaration(statement))
    const hasUnpriceImport = imports.some((statement) => {
      const bindings = statement.importClause?.namedBindings
      return (
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some((binding) => binding.name.text === "Unprice")
      )
    })
    files.set(
      resolve(__dirname, `__example_${index}.ts`),
      [
        hasUnpriceImport ? "" : 'import { Unprice } from "@unprice/api"',
        ...imports.map((statement) => statement.getText(source)),
        "type ResponseExcerpt<T> = T extends readonly (infer Item)[] ? ResponseExcerpt<Item>[] : T extends object ? { [Key in keyof T]?: ResponseExcerpt<T[Key]> } : T",
        "async function example() {",
        /\b(?:const|let|var)\s+unprice\b/.test(example.code)
          ? ""
          : 'const unprice = new Unprice({ token: "example" })',
        ...body.map((statement) => statement.getText(source)),
        "}",
      ].join("\n")
    )
  }
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    noImplicitAny: false,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ["node"],
    baseUrl: root,
    paths: {
      "@unprice/api": ["packages/api/src/index.ts"],
      "@unprice/budgets": ["packages/budgets/src/index.ts"],
      "@unprice/budgets-ai": ["packages/budgets-ai/src/index.ts"],
      "@unprice/ai-sdk-budget": ["packages/ai-sdk-budget/src/index.ts"],
      "@unprice/pi-budget": ["packages/pi-budget/src/index.ts"],
      "@unprice/pi-budget/tools": ["packages/pi-budget/src/tool.ts"],
    },
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const code = files.get(file)
    return code === undefined
      ? getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(file, code, languageVersion, true)
  }
  const program = ts.createProgram([...files.keys()], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
    // Guides omit application setup and optional provider packages. Keep all contract errors.
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    const optionalImport = diagnostic.code === 2307 && !message.includes("'@unprice/")
    return (
      diagnostic.file &&
      files.has(diagnostic.file.fileName) &&
      !optionalImport &&
      ![2304, 18004, 2552].includes(diagnostic.code)
    )
  })
  const names = [...files.keys()]
  return diagnostics.map((diagnostic) => ({
    example: examples[names.indexOf(diagnostic.file?.fileName ?? "")]?.label,
    error: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }))
}

describe("published SDK examples", () => {
  it("rejects retired usage, status cursor, and charge explanation contracts", () => {
    const examples = [
      'await unprice.usage.record({ eventSlug: "tokens", idempotencyKey: "event" })',
      'await unprice.usage.consume({ eventSlug: "tokens", idempotencyKey: "event", featureSlug: "tokens" })',
      'await unprice.ingestionEvents.status({ cursor: { handledAt: 1, canonicalAuditId: "event", sourceId: "payer" } })',
      'const { result } = await unprice.analytics.charges.explain({ invoice_id: "invoice", entry_id: "entry" }); if (result) console.info(result.events[0]?.grant_id)',
    ]
    const cases = examples.map((code, index) => ({ label: `retired contract ${index}`, code }))
    const diagnostics = checkExamples(cases)
    for (const example of cases) {
      expect(
        diagnostics.some((diagnostic) => diagnostic.example === example.label),
        example.label
      ).toBe(true)
    }
  }, 30_000)

  it("typechecks every generated SDK method with default and custom meter parameters", () => {
    const params: (SDKExampleParams | undefined)[] = [
      undefined,
      {
        apiToken: "example",
        customerId: "cus_example",
        usage: {
          eventSlug: "completions",
          featureSlug: "messages",
          aggregationField: "input-tokens",
        },
      },
    ]
    const examples = METHOD_ORDER.flatMap((method) =>
      params.map((value, index) => ({
        label: `${method} (${index})`,
        code: getCodeExample("sdk", method, value),
      }))
    )
    expect(checkExamples(examples)).toEqual([])
  }, 30_000)

  it("checks fetch and curl request bodies against the same SDK contracts", () => {
    const operationSchema = z.object({ operationId: z.string() })
    const document = z
      .object({
        paths: z.record(
          z.string(),
          z.object({ get: operationSchema.optional(), post: operationSchema.optional() })
        ),
      })
      .parse(JSON.parse(readFileSync(resolve(root, "apps/docs/openapi.json"), "utf8")))
    const examples: { label: string; code: string }[] = []
    for (const method of METHOD_ORDER) {
      for (const framework of ["fetch", "curl"] as const) {
        const code = getCodeExample(framework, method)
        let body: string | undefined
        let url: URL
        if (framework === "fetch") {
          const path = code.match(/fetch\(baseUrl \+ ("[^"]+")/)?.[1]
          if (!path) throw new Error(`Missing fetch URL for ${method}`)
          url = new URL(JSON.parse(path), "https://example.com")
          examples.push({ label: `fetch ${method} source`, code })
          const source = ts.createSourceFile("fetch.ts", code, ts.ScriptTarget.Latest, true)
          const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && node.expression.getText(source) === "JSON.stringify") {
              body = node.arguments[0]?.getText(source)
            }
            ts.forEachChild(node, visit)
          }
          visit(source)
        } else {
          const address = code.match(/curl -sS "([^"]+)"/)?.[1]
          if (!address) throw new Error(`Missing curl URL for ${method}`)
          url = new URL(address)
          const json = code.match(/-d '([\s\S]*)'\s*$/)?.[1]
          if (json)
            body = JSON.stringify(
              JSON.parse(json.replaceAll("'\"$(date +%s)000\"'", "1794038400000"))
            )
        }
        const operation =
          document.paths[url.pathname]?.[body === undefined ? "get" : "post"]?.operationId
        if (!operation) throw new Error(`Unknown endpoint ${url.pathname}`)
        examples.push({
          label: `${framework} ${method}`,
          code: `await unprice.${operation}(${body ?? JSON.stringify(Object.fromEntries(url.searchParams))})`,
        })
      }
    }
    expect(checkExamples(examples)).toEqual([])
  }, 30_000)

  it("typechecks SDK calls and response examples in the public docs and package READMEs", () => {
    const examples: { label: string; code: string }[] = []
    const paths = globSync(
      [
        "apps/docs/**/*.mdx",
        "apps/**/*.md",
        "internal/**/*.md",
        "packages/*/README.md",
        "tooling/**/*.md",
        "README.md",
        "docs/*.md",
        "docs/brand/*.md",
      ],
      { cwd: root, exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.turbo/**"] }
    )
    for (const path of paths) {
      const markdown = readFileSync(resolve(root, path), "utf8")
      for (const match of markdown.matchAll(
        /```(?:ts|typescript|tsx|js|javascript)\n([\s\S]*?)```/g
      )) {
        const code = match[1] ?? ""
        if (!code.includes("unprice.")) continue
        examples.push({
          label: `${path}:${markdown.slice(0, match.index).split("\n").length}`,
          code,
        })
      }
      const operation = markdown.match(/\bunprice\.([\w.]+)\(/)?.[1]
      if (!operation) continue
      for (const match of markdown.matchAll(/<ResponseExample>\s*```json\n([\s\S]*?)```/g)) {
        const resultType = `NonNullable<Awaited<ReturnType<Unprice${operation
          .split(".")
          .map((part) => `[${JSON.stringify(part)}]`)
          .join("")}>>["result"]>`
        const responseType = markdown.includes("response example shows selected")
          ? `ResponseExcerpt<${resultType}>`
          : resultType
        examples.push({
          label: `${path} response`,
          code: `const response: ${responseType} = ${match[1]}`,
        })
      }
    }
    expect(examples.length).toBeGreaterThan(30)
    expect(checkExamples(examples)).toEqual([])
  }, 30_000)

  it("typechecks static SDK snippets displayed by the app", () => {
    const examples: { label: string; code: string }[] = []
    for (const path of globSync("apps/nextjs/src/**/*.{ts,tsx}", { cwd: root })) {
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue
      const source = ts.createSourceFile(
        path,
        readFileSync(resolve(root, path), "utf8"),
        ts.ScriptTarget.Latest,
        true
      )
      const visit = (node: ts.Node) => {
        if (
          (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) &&
          node.text.includes("new Unprice(") &&
          node.text.includes("unprice.")
        ) {
          examples.push({ label: path, code: node.text })
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(examples.length).toBeGreaterThan(0)
    expect(checkExamples(examples)).toEqual([])
  }, 30_000)
})
