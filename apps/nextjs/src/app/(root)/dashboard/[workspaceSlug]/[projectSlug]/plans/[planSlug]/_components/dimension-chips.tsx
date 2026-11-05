"use client"

import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"
import { Plus, X } from "lucide-react"
import { type KeyboardEvent, useState } from "react"

/** An event property a price can vary by; "#" starts reserved names (`propertyNameSchema`). */
const PROPERTY_NAME = /^[^#\s,]+$/

/** The property names in typed text, split on commas, trimmed, valid, and not already in `current`. */
export function parseDimensionInput(text: string, current: readonly string[]): string[] {
  const added: string[] = []
  for (const part of text.split(",")) {
    const name = part.trim()
    if (!PROPERTY_NAME.test(name) || current.includes(name) || added.includes(name)) continue
    added.push(name)
  }
  return added
}

/**
 * Free-text chips for the event properties a feature's price varies by (`meterConfig.groupBy`).
 * Enter or a comma adds what was typed; a chip's cross removes it. A suggestion chip offers the
 * common case when none is set.
 */
export function DimensionChips({
  value,
  onChange,
  isDisabled,
  suggestions = ["model"],
}: {
  value: readonly string[]
  onChange: (next: string[]) => void
  isDisabled?: boolean
  suggestions?: readonly string[]
}) {
  const [text, setText] = useState("")

  const add = (raw: string) => {
    const added = parseDimensionInput(raw, value)
    if (added.length > 0) onChange([...value, ...added])
    setText("")
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      add(text)
    } else if (event.key === "Backspace" && text === "" && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1 text-sm focus-within:ring-1 focus-within:ring-ring",
          isDisabled && "opacity-50"
        )}
      >
        {value.map((name) => (
          <Badge key={name} variant="secondary" className="gap-1 rounded-sm px-1.5 py-0 font-mono">
            {name}
            {!isDisabled && (
              <button
                type="button"
                className="rounded-sm text-muted-foreground hover:text-foreground"
                onClick={() => onChange(value.filter((entry) => entry !== name))}
              >
                <X className="size-3" />
                <span className="sr-only">Remove {name}</span>
              </button>
            )}
          </Badge>
        ))}
        <input
          aria-label="Price varies by"
          className="min-w-24 flex-1 bg-transparent font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground disabled:cursor-not-allowed"
          placeholder={value.length === 0 ? "property name, Enter to add" : ""}
          value={text}
          disabled={isDisabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(text)}
        />
      </div>
      {!isDisabled && value.length === 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 font-mono text-xs"
              onClick={() => add(suggestion)}
            >
              <Plus className="size-3" />
              {suggestion}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
