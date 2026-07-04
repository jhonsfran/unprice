"use client"

import { cn } from "@unprice/ui/utils"
import { useTheme } from "next-themes"
import { Highlight, themes } from "prism-react-renderer"
import { useMounted } from "~/hooks/use-mounted"

export function CodeEditor({
  codeBlock,
  language,
  className,
  lineNumberClassName,
  codeClassName,
  tokenClassName,
}: {
  codeBlock: string
  language: string
  className?: string
  lineNumberClassName?: string
  codeClassName?: string
  tokenClassName?: string
}) {
  const { resolvedTheme } = useTheme()
  const isMounted = useMounted()

  if (!isMounted) return null

  return (
    <Highlight
      code={codeBlock}
      language={language}
      theme={resolvedTheme === "dark" ? themes.nightOwl : themes.nightOwlLight}
    >
      {({ className: prismClassName, style, tokens, getLineProps, getTokenProps }) => {
        return (
          <pre
            className={cn("h-full overflow-x-hidden text-sm leading-6", prismClassName, className)}
            style={{ ...style, background: "transparent" }}
          >
            {tokens.map((line, i) => {
              const { key: lineKey, ...lineProps } = getLineProps({
                line,
                key: i,
              })

              return (
                <div key={i.toString()} {...lineProps} className="table-row">
                  <span
                    className={cn(
                      "table-cell select-none pr-4 text-right text-background-line",
                      lineNumberClassName
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className={cn("table-cell whitespace-pre-wrap break-words", codeClassName)}>
                    {line.map((token, j) => {
                      const { key: tokenKey, ...tokenProps } = getTokenProps({
                        token,
                        key: j,
                      })
                      return (
                        <span
                          key={j.toString()}
                          {...tokenProps}
                          className={cn(tokenProps.className, tokenClassName)}
                        />
                      )
                    })}
                  </span>
                </div>
              )
            })}
          </pre>
        )
      }}
    </Highlight>
  )
}
