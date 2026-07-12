import type { CSSProperties } from "react"

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

// Shared geometry. The bracket-U is one continuous stroke — short top serifs for
// a clear opening, arms joined across the base — and the value it gates. The dot
// rides 0.4 above the cavity's geometric center (y 4..16): enough optical lift to
// read cradled, without crowding the gate mouth.
const BRACKET_PATH = "M7.5 2.5 L3 2.5 L3 17.5 L17 17.5 L17 2.5 L12.5 2.5"
const DOT = { cx: 10, cy: 9.6, r: 3 }

function IconMark({
  px,
  strokeColor,
  value,
  style,
}: {
  px: number
  strokeColor: string
  value: string
  style?: CSSProperties
}) {
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 20 20"
      className="shrink-0"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Unprice logo"
      style={style}
    >
      <path
        d={BRACKET_PATH}
        stroke={strokeColor}
        strokeWidth="3"
        strokeLinecap="butt"
        strokeLinejoin="miter"
        fill="none"
      />
      {/* The value gated within the U — cradled at optical center. */}
      <circle cx={DOT.cx} cy={DOT.cy} r={DOT.r} fill={value} />
    </svg>
  )
}

function Wordmark({ text, color }: { text: number; color: string }) {
  return (
    <span
      style={{
        fontSize: `${text}px`,
        color,
        fontWeight: 600,
        letterSpacing: "-0.04em",
        lineHeight: 1,
      }}
      className="font-primary"
    >
      unprice
    </span>
  )
}

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
  const iconValue = monochrome ? ink : signal

  // The mark is a bracket-U gating a single value. The two brackets are joined at
  // the bottom into one continuous stroke — down the left arm, across the base, up
  // the right arm — so it reads at once as code-native brackets AND a U (unprice)
  // that cradles/gates the value held inside. "Un-hardcode pricing," pulled into
  // one inspectable place. Color lands only on the element that changes a decision.
  // Mitered corners and flush top serifs keep it engineered and ownable.
  if (variant === "icon") {
    return (
      <div className={cn("inline-flex", className)}>
        <IconMark px={px} strokeColor={ink} value={iconValue} />
      </div>
    )
  }

  if (variant === "wordmark") {
    return (
      <div className={cn("inline-flex", className)}>
        <Wordmark text={text} color={ink} />
      </div>
    )
  }

  return (
    <div className={cn("inline-flex items-center", className)} style={{ gap: `${gap}px` }}>
      {/* Flex-centering hangs the mark ~0.02em high of the lowercase word's optical
          band (measured against Geist's x-height); the nudge settles it. */}
      <IconMark
        px={px}
        strokeColor={ink}
        value={iconValue}
        style={{ transform: `translateY(${(text * 0.02).toFixed(2)}px)` }}
      />
      <Wordmark text={text} color={ink} />
    </div>
  )
}

export interface UnpriceSpinnerProps {
  /** Concrete mark sizes; the brand minimum for the mark is 16px. */
  size?: "sm" | "md" | "lg" | "xl"
  /**
   * "dark"/"light" pin the brand hexes for controlled surfaces. "inherit" is for
   * product UI: brackets ride currentColor (like any icon next to text) and the
   * value steps amber-11 → amber-9 with the app's `.dark` class.
   */
  theme?: "dark" | "light" | "inherit"
  /** Render the moving value in ink instead of amber (for monochrome contexts). */
  monochrome?: boolean
  /** Accessible status text announced to screen readers. */
  label?: string
  /** Merged onto the svg (like an icon), so `size-*` utilities override the size prop. */
  className?: string
}

const spinnerSizes = { sm: 16, md: 20, lg: 32, xl: 48 }

// While loading, the value bounces in its cradle: apex just clear of the gate
// mouth (it cannot pass — the dot is wider than the opening), contact kissing
// the base, one bounce per second. The fall accelerates (ease-in-quad, gravity)
// and the rise decelerates on the brand's ease-out-quad. Rigid ball, no squash:
// engineered, not cartoon. The brackets never move and never recolor — they are
// the calm infrastructure; amber stays on the one element in flight, and it
// stays on its vertical axis. Under prefers-reduced-motion the bounce is
// replaced by the value resting in its cradle, breathing opacity — progress
// stays legible without positional motion.
export function UnpriceSpinner({
  size = "md",
  theme = "dark",
  monochrome = false,
  label = "Loading",
  className = "",
}: UnpriceSpinnerProps) {
  const px = spinnerSizes[size]
  const inherit = theme === "inherit"
  const ink = inherit ? "currentColor" : theme === "dark" ? "#fafafa" : "#0a0a0a"
  // In inherit mode the value's surface-aware amber step lives in the <style>
  // rules below (.dark flips it), so the circle carries a class instead of a fill.
  const value = monochrome
    ? ink
    : inherit
      ? undefined
      : theme === "dark"
        ? SIGNAL_ON_DARK
        : SIGNAL_ON_LIGHT
  const valueClass = !monochrome && inherit ? "unprice-logo-value" : undefined

  return (
    <output aria-label={label} className="inline-flex">
      <svg
        width={px}
        height={px}
        viewBox="0 0 20 20"
        className={cn("shrink-0", className)}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <style>{`
          @keyframes unprice-logo-bounce {
            0% { transform: translateY(0); animation-timing-function: cubic-bezier(.55,.085,.68,.53); }
            50% { transform: translateY(5px); animation-timing-function: cubic-bezier(.25,.46,.45,.94); }
            100% { transform: translateY(0); }
          }
          @keyframes unprice-logo-breathe { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
          .unprice-logo-bounce { animation: unprice-logo-bounce 1s infinite; }
          .unprice-logo-value { fill: ${SIGNAL_ON_LIGHT}; }
          .dark .unprice-logo-value { fill: ${SIGNAL_ON_DARK}; }
          .unprice-logo-rest { display: none; }
          @media (prefers-reduced-motion: reduce) {
            .unprice-logo-bounce { display: none; }
            .unprice-logo-rest {
              display: inline;
              animation: unprice-logo-breathe 2.4s ease-in-out infinite;
            }
          }
        `}</style>
        <path
          d={BRACKET_PATH}
          stroke={ink}
          strokeWidth="3"
          strokeLinecap="butt"
          strokeLinejoin="miter"
          fill="none"
        />
        <g className="unprice-logo-bounce">
          <circle className={valueClass} cx="10" cy="8" r={DOT.r} fill={value} />
        </g>
        <circle
          className={cn("unprice-logo-rest", valueClass)}
          cx={DOT.cx}
          cy={DOT.cy}
          r={DOT.r}
          fill={value}
        />
      </svg>
    </output>
  )
}
