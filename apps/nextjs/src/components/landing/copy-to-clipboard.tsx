"use client"

import { Button, type ButtonProps } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"
import { CheckIcon, CopyIcon } from "lucide-react"
import React from "react"

export default function CopyToClipboard({
  code,
  className,
  label,
  variant = "default",
  size = "icon",
}: {
  code: string
  className?: string
  label?: string
  variant?: ButtonProps["variant"]
  size?: ButtonProps["size"]
}) {
  const [copied, setCopied] = React.useState(false)
  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch (error) {
      console.error("Error copying to clipboard", error)
    } finally {
      setTimeout(() => {
        setCopied(false)
      }, 1500)
    }
  }
  return (
    <Button
      size={size}
      variant={variant}
      onClick={copyToClipboard}
      className={cn("select-none", className)}
      aria-label={copied ? "Copied code" : "Copy code"}
    >
      {!copied ? (
        <CopyIcon aria-hidden="true" className="size-3.5" />
      ) : (
        <CheckIcon aria-hidden="true" className="size-3.5 text-success-text" />
      )}
      {label ? <span>{copied ? "Copied" : label}</span> : null}
    </Button>
  )
}
