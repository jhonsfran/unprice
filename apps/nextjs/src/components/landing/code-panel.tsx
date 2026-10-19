import { cn } from "@unprice/ui/utils"
import { BUDGETS_INSTALL } from "./budgets-snippets"
import { CodeEditor } from "./code-editor"
import CopyToClipboard from "./copy-to-clipboard"

// The two code surfaces the Budgets page and the Budgets setup share, so both show the install
// line and the snippet the same way.

/** The package install line, with its copy button. */
export function InstallCommand({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-background-border bg-surface-panel py-1 pr-1 pl-3",
        className
      )}
    >
      <span aria-hidden className="select-none font-mono text-background-text text-xs">
        $
      </span>
      <code className="font-mono text-background-textContrast text-xs">{BUDGETS_INSTALL}</code>
      <CopyToClipboard code={BUDGETS_INSTALL} variant="ghost" className="size-7" />
    </div>
  )
}

/**
 * A file of code under its name. `copyCode` is what the copy button copies when it differs from
 * what is shown (the setup shows a masked key and copies the real one); `copyLabel` names the
 * button instead of an icon alone.
 */
export function CodePanel({
  filename,
  code,
  copyCode = code,
  copyLabel,
  className,
}: {
  filename: string
  code: string
  copyCode?: string
  copyLabel?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-background-border bg-surface-panel",
        className
      )}
    >
      <div className="flex items-center justify-between gap-4 border-background-border border-b py-1.5 pr-1.5 pl-4 sm:pl-5">
        <span className="font-mono text-background-text text-xs uppercase tracking-widest">
          {filename}
        </span>
        {copyLabel ? (
          <CopyToClipboard
            code={copyCode}
            variant="ghost"
            size="sm"
            label={copyLabel}
            className="gap-1.5"
          />
        ) : (
          <CopyToClipboard code={copyCode} variant="ghost" className="size-7" />
        )}
      </div>
      <div className="overflow-x-auto px-4 py-4 sm:px-5">
        <CodeEditor codeBlock={code} language="typescript" />
      </div>
    </div>
  )
}
