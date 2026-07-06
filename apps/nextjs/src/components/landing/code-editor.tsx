"use client"

import { cn } from "@unprice/ui/utils"
import { Highlight, Prism, type PrismTheme } from "prism-react-renderer"

// prism-react-renderer's vendored Prism ships no shell grammar, so
// language="bash" would render as plain text. Register the small subset the
// generated cURL examples need; single-quoted payloads are re-tokenized so
// JSON keys, values, and amounts read individually.
Prism.languages.bash = {
  comment: { pattern: /(^|\s)#.*/, lookbehind: true },
  string: [
    {
      pattern: /'[\s\S]*?'/,
      greedy: true,
      inside: {
        property: /"(?:\\.|[^"\\])*"(?=\s*:)/,
        string: /"(?:\\.|[^"\\])*"/,
        number: /-?\b\d+(?:\.\d+)?\b/,
        punctuation: /[{}[\],:']/,
      },
    },
    {
      pattern: /"(?:\\[\s\S]|[^"\\])*"/,
      greedy: true,
      inside: {
        environment: /\$[A-Za-z_][A-Za-z0-9_]*/,
      },
    },
  ],
  environment: /\$[A-Za-z_][A-Za-z0-9_]*/,
  function: /\b(?:curl|echo|export|node|npm|npx|pnpm)\b/,
  parameter: { pattern: /(^|\s)--?[\w-]+/, lookbehind: true },
  number: /\b\d+(?:\.\d+)?\b/,
  operator: /\\$|[|&;<>]/m,
  punctuation: /[{}[\]();,:]/,
}

// Colors come from the semantic token classes below instead of a prism
// palette, so the editor follows the active theme (light/dark, sunset/slate)
// and can render on the server without a client-side theme lookup.
const TOKEN_THEME: PrismTheme = { plain: {}, styles: [] }

// Calm grammar, colored facts: identifiers stay ink, structure recedes to
// muted text, strings and numbers (slugs, IDs, amounts — the value being
// gated) carry the brand primary, and callable actions use the
// live-request info color.
const TOKEN_TYPE_CLASS: Record<string, string> = {
  comment: "italic text-background-solidHover",
  string: "text-primary-text",
  "template-string": "text-primary-text",
  "attr-value": "text-primary-text",
  url: "text-primary-text",
  regex: "text-primary-text",
  char: "text-primary-text",
  number: "text-primary-text",
  boolean: "text-primary-text",
  environment: "text-primary-text",
  variable: "text-primary-text",
  function: "text-info-text",
  keyword: "text-background-text",
  operator: "text-background-text",
  punctuation: "text-background-text",
}

// In shell snippets almost everything is a quoted string (URL, headers, the
// whole -d payload), so brand amber would flood the panel. Strings step down
// to the quiet secondary warm; the command keeps the action color, JSON keys
// stay ink, and `$UNPRICE_TOKEN` keeps the primary accent.
const BASH_TOKEN_TYPE_CLASS: Record<string, string> = {
  ...TOKEN_TYPE_CLASS,
  string: "text-secondary-text",
  "attr-value": "text-secondary-text",
  url: "text-secondary-text",
  property: "text-background-textContrast",
  parameter: "text-background-text",
}

function getTokenClass(types: string[], language: string) {
  const typeClassMap = language === "bash" ? BASH_TOKEN_TYPE_CLASS : TOKEN_TYPE_CLASS
  // Walk from the innermost type outward so nested tokens (a number inside a
  // quoted JSON payload) win over their container.
  for (let i = types.length - 1; i >= 0; i--) {
    const type = types[i]
    if (!type) continue
    const tokenClass = typeClassMap[type]
    if (tokenClass) return tokenClass
  }
  return undefined
}

export function CodeEditor({
  codeBlock,
  language,
  className,
}: {
  codeBlock: string
  language: string
  className?: string
}) {
  return (
    <Highlight code={codeBlock.replace(/\n+$/, "")} language={language} theme={TOKEN_THEME}>
      {({ tokens }) => (
        <pre
          className={cn(
            // bg-transparent + rounded-none neutralize the global `pre` rule
            // in globals.css so the surface behind the editor shows through.
            "h-full w-full overflow-x-hidden rounded-none bg-transparent font-mono text-[13px] text-background-textContrast leading-6 selection:bg-primary-bg",
            className
          )}
        >
          {tokens.map((line, lineIndex) => (
            <div key={lineIndex.toString()} className="table-row">
              <span className="table-cell w-8 select-none pr-3 text-right text-background-solid">
                {lineIndex + 1}
              </span>
              <span className="table-cell whitespace-pre-wrap break-words">
                {line.map((token, tokenIndex) => (
                  <span
                    key={tokenIndex.toString()}
                    className={getTokenClass(token.types, language)}
                  >
                    {token.content}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  )
}
