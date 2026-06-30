import { cn } from "@unprice/ui/utils"

interface UnpriceLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl"
  variant?: "full" | "icon" | "wordmark"
  theme?: "dark" | "light"
  /** Render the action point in ink instead of the amber signal (for monochrome contexts). */
  monochrome?: boolean
  className?: string
}

// Icon is optically sized to the wordmark's cap height so the mark sits as a
// peer to the letters, not a billboard beside them. Gaps are ~0.24em.
const sizes = {
  xs: { text: 13, gap: 3 },
  sm: { text: 17, gap: 4 },
  md: { text: 24, gap: 6 },
  lg: { text: 38, gap: 9 },
  xl: { text: 56, gap: 13 },
}

// Brand signal — Radix amber. On dark surfaces the dot is amber-9 (#ffc53d, the
// platform `primary`); on light surfaces it steps to amber-11 (#ab6400) so the
// gated value keeps contrast — amber-9 on near-white is only ~1.4:1. Same hue,
// surface-aware step. Brackets stay neutral ink; color lands only on the point
// that changes a decision. See docs/brand/design-tokens.md.
const SIGNAL_ON_DARK = "#ffc53d" // amber-9, on near-black
const SIGNAL_ON_LIGHT = "#ab6400" // amber-11, on near-white

export default function UnpriceLogo({
  size = "md",
  variant = "full",
  theme = "dark",
  monochrome = false,
  className = "",
}: UnpriceLogoProps) {
  const { text, gap } = sizes[size]
  // The icon viewBox is cropped to the ink (below), so px maps almost 1:1 to the
  // visible mark; 0.82 lands the brackets at ~cap height next to the wordmark.
  const px = Math.round(text * 0.82)

  const ink = theme === "dark" ? "#fafafa" : "#0a0a0a"
  const signal = theme === "dark" ? SIGNAL_ON_DARK : SIGNAL_ON_LIGHT

  // The mark is a pair of brackets cradling a single point: pricing pulled out of
  // product code into one inspectable place — "un-hardcode pricing" — with the gated
  // value held inside. Color lands only on the element that changes a decision, which
  // is the product's own law. Reads as brackets, not a letter, down to favicon size.
  // The viewBox is cropped to the ink so the lockup gap is true; the favicon tiles
  // keep their own padded 32×32 box (apps/nextjs/**/icon.svg).
  const IconMark = () => {
    const action = monochrome ? ink : signal
    return (
      <svg
        width={px}
        height={px}
        viewBox="4 4 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Unprice logo"
      >
        {/* Left and right brackets: code-native containment. Square feet keep them
            unmistakably brackets, not a letter. */}
        <path
          d="M13.5 6 L8 6 L8 26 L13.5 26"
          stroke={ink}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <path
          d="M18.5 6 L24 6 L24 26 L18.5 26"
          stroke={ink}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* The value held within the brackets — amber signal (primary), ink when monochrome. */}
        <circle cx="16" cy="16" r="3.3" fill={action} />
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
      className="font-primary"
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
