import { cn } from "@unprice/ui/utils"

interface UnpriceLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl"
  variant?: "full" | "icon" | "wordmark"
  theme?: "dark" | "light"
  /** Render the active knob in ink instead of amber (for monochrome contexts). */
  monochrome?: boolean
  className?: string
}

// Icon is optically sized to the wordmark's cap height so the mark sits as a
// peer to the letters, not a billboard beside them.
const sizes = {
  xs: { text: 13, gap: 5 },
  sm: { text: 17, gap: 6 },
  md: { text: 24, gap: 8 },
  lg: { text: 38, gap: 11 },
  xl: { text: 56, gap: 18 },
}

const AMBER = "#f5b62b"

export default function UnpriceLogo({
  size = "md",
  variant = "full",
  theme = "dark",
  monochrome = false,
  className = "",
}: UnpriceLogoProps) {
  const { text, gap } = sizes[size]
  const px = Math.round(text * 1.04)

  const ink = theme === "dark" ? "#fafafa" : "#0a0a0a"

  // An app-icon-quality monogram: a solid amber tile with a bold geometric "u"
  // (unprice) on it. The mark is an identity, not a UI widget — the product
  // thesis lives in the words. Reads as a finished product at any size.
  const IconMark = () => {
    const glyph = monochrome ? ink : "#0a0a0a"
    return (
      <svg
        width={px}
        height={px}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Unprice logo"
      >
        {/* Tile — amber in brand contexts, ink when monochrome */}
        {!monochrome && <rect x="0" y="0" width="24" height="24" rx="6" fill={AMBER} />}
        {/* Bold "u" — the right stem rises taller than the left: a quiet nod to
            growth/upside, and the trait that makes the silhouette ownable. */}
        <path
          d="M7.5 7.5 L7.5 13 A4.5 4.5 0 0 0 16.5 13 L16.5 4.5"
          stroke={monochrome ? ink : glyph}
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    )
  }

  const Wordmark = () => (
    <span
      style={{
        fontSize: `${text}px`,
        color: ink,
        fontWeight: 600,
        letterSpacing: "-0.04em",
        lineHeight: 1,
      }}
      className="font-sans"
    >
      unprice
    </span>
  )

  if (variant === "icon") {
    return (
      <div className={cn("inline-flex", className)}>
        <IconMark />
      </div>
    )
  }

  if (variant === "wordmark") {
    return (
      <div className={cn("inline-flex", className)}>
        <Wordmark />
      </div>
    )
  }

  return (
    <div className={cn("inline-flex items-center", className)} style={{ gap: `${gap}px` }}>
      <IconMark />
      <Wordmark />
    </div>
  )
}
