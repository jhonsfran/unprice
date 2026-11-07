"use client"

import { Button } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"
import { Plus, X } from "lucide-react"
import { type KeyboardEvent, useRef, useState } from "react"

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
 * Enter or a comma adds what was typed; a chip's cross removes it. Suggestions offer the event's
 * own properties, so the common case is one click instead of typing a name from memory.
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
  const inputRef = useRef<HTMLInputElement>(null)
  const offered = suggestions.filter((suggestion) => !value.includes(suggestion))

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
      {/* One bordered field: the chips and the typing area share it, so it reads as one input. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the input inside takes the keyboard */}
      <div
        className={cn(
          "flex min-h-9 cursor-text flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1 text-sm transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring",
          isDisabled && "cursor-not-allowed opacity-50"
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((name) => (
          <span
            key={name}
            className="inline-flex h-6 items-center gap-1 rounded-sm bg-background-bgHover pr-1 pl-2 font-mono text-xs"
          >
            {name}
            {!isDisabled && (
              <button
                type="button"
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-background-bgActive hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation()
                  onChange(value.filter((entry) => entry !== name))
                }}
              >
                <X className="size-3" />
                <span className="sr-only">Remove {name}</span>
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          aria-label="Price varies by"
          // The global stylesheet borders every input; inside the field it must not draw its own.
          className="h-6 min-w-24 flex-1 border-0 bg-transparent p-0 font-mono text-xs shadow-none outline-none placeholder:font-sans placeholder:text-muted-foreground focus:border-0 focus:outline-none focus:ring-0 disabled:cursor-not-allowed"
          placeholder={value.length === 0 ? "Type a property name and press Enter" : "Add another"}
          value={text}
          disabled={isDisabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(text)}
        />
      </div>
      {!isDisabled && offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Suggested:</span>
          {offered.map((suggestion) => (
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
