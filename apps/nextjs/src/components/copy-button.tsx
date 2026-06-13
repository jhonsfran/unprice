"use client"

import * as React from "react"

import { CopyDone } from "@unprice/ui/icons"
import { cn } from "@unprice/ui/utils"
import { Copy } from "lucide-react"

interface CopyButtonProps extends React.HTMLAttributes<HTMLButtonElement> {
  value: string
  src?: string
  onClick?: () => void
}

async function copyToClipboardWithMeta(value: string, _meta?: Record<string, unknown>) {
  navigator.clipboard.writeText(value)
}

export function CopyButton({ value, className, src, onClick, ...props }: CopyButtonProps) {
  const [hasCopied, setHasCopied] = React.useState(false)

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setHasCopied(false)
    }, 2000)
    return () => clearTimeout(timer)
  }, [hasCopied])

  return (
    <button
      type="button"
      className={"relative p-1"}
      onClick={() => {
        copyToClipboardWithMeta(value, {
          component: src,
        })
        setHasCopied(true)
        onClick?.()
      }}
      {...props}
    >
      <span className="sr-only">Copy</span>
      {hasCopied ? (
        <CopyDone className={cn("size-4", className)} />
      ) : (
        <Copy className={cn("size-4", className)} />
      )}
    </button>
  )
}
