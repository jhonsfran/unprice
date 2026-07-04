import { cn } from "@unprice/ui/utils"

export interface UnpriceLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl"
  variant?: "full" | "icon" | "wordmark"
  theme?: "dark" | "light"
  /** Render the held value in ink instead of the amber signal (for monochrome contexts). */
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

// Brand signal — amber, surface-aware. On dark surfaces the value is amber-9
// (#ffc53d); on light surfaces it steps to amber-11 (#ab6400) so the gated value
// keeps contrast (amber-9 on near-white is only ~1.4:1). Same hue, different step.
const SIGNAL_ON_DARK = "#ffc53d"
const SIGNAL_ON_LIGHT = "#ab6400"

export default function UnpriceLogo({
  size = "md",
  variant = "full",
  theme = "dark",
  monochrome = false,
  className = "",
}: UnpriceLogoProps) {
  const { text, gap } = sizes[size]
  // viewBox is cropped tight and evenly padded around the ink, so px maps ~1:1
  // to the visible mark; 0.86 lands the mark at ~cap height beside the wordmark.
  const px = Math.round(text * 0.86)

  const ink = theme === "dark" ? "#fafafa" : "#0a0a0a"
  const signal = theme === "dark" ? SIGNAL_ON_DARK : SIGNAL_ON_LIGHT

  // The mark is a bracket-U gating a single value. The two brackets are joined at
  // the bottom into one continuous stroke — down the left arm, across the base, up
  // the right arm — so it reads at once as code-native brackets AND a U (unprice)
  // that cradles/gates the value held inside. "Un-hardcode pricing," pulled into
  // one inspectable place. Color lands only on the element that changes a decision.
  // Mitered corners and flush top serifs keep it engineered and ownable.
  const IconMark = () => {
    const value = monochrome ? ink : signal
    return (
      <svg
        width={px}
        height={px}
        viewBox="6 6 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Unprice logo"
      >
        {/* Bracket-U: short top serifs for a clear opening, arms joined across
            the base into one continuous stroke, centered with even padding. */}
        <path
          d="M13.5 8.5 L9 8.5 L9 23.5 L23 23.5 L23 8.5 L18.5 8.5"
          stroke={ink}
          strokeWidth="3"
          strokeLinecap="butt"
          strokeLinejoin="miter"
          fill="none"
        />
        {/* The value gated within the U — cradled at optical center. */}
        <circle cx="16" cy="15.1" r="3" fill={value} />
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
