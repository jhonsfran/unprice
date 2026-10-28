"use client"

import { Button } from "@unprice/ui/button"
import { useState } from "react"
import { CopyButton } from "~/components/copy-button"

/** The new runtime key, once: in its own box, with a copy button and the warning beside it. */
export function RevealedKey({ apiKey, onContinue }: { apiKey: string; onContinue: () => void }) {
  const [copied, setCopied] = useState(false)

  return (
    <section
      aria-label="Your new runtime key"
      className="flex flex-col gap-4 rounded-md border border-warning-border bg-warning-bg p-4"
    >
      <div className="flex flex-col gap-1">
        <p className="font-medium text-background-textContrast text-sm">Your runtime key</p>
        <p role="alert" className="text-sm text-warning-text">
          Shown once. Copy it now and keep it somewhere safe: after you leave this step it cannot be
          shown again, only replaced with a new key.
        </p>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-background-border bg-surface-raised px-3 py-2">
        <code
          data-testid="revealed-runtime-key"
          className="min-w-0 flex-1 break-all font-mono text-xs"
        >
          {apiKey}
        </code>
        <CopyButton
          value={apiKey}
          aria-label="Copy runtime key"
          onClick={() => setCopied(true)}
          className="text-background-text"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="primary" className="w-fit" onClick={onContinue}>
          {copied ? "I copied it, continue" : "Continue"}
        </Button>
        <span className="text-background-text text-xs">
          The next step puts this key into the code for you when you copy it.
        </span>
      </div>
    </section>
  )
}
