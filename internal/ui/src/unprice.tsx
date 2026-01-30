import { cn } from "./utils/index"

interface UnpriceLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl"
  variant?: "full" | "icon" | "wordmark"
  theme?: "dark" | "light"
  className?: string
}

export default function UnpriceLogo({
  size = "md",
  variant = "full",
  theme = "dark",
  className = "",
}: UnpriceLogoProps) {
  // 1. SCALING SYSTEM
  // We use a 24px grid as the base (size "sm").
  // All other sizes scale from this ratio to ensure pixel perfection.
  const sizes = {
    // xs: Gap reduced 4px -> 3px
    xs: { px: 16, text: 12, gap: 3 },

    // sm: Gap reduced 6px -> 4px
    sm: { px: 24, text: 16, gap: 4 },

    // md: Gap reduced 8px -> 5px (The critical fix)
    md: { px: 32, text: 24, gap: 5 },

    // lg: Gap reduced 10px -> 8px
    lg: { px: 48, text: 38, gap: 8 },

    // xl: Gap reduced 12px -> 10px
    xl: { px: 64, text: 48, gap: 10 },
  }

  const { px, text, gap } = sizes[size]

  // 2. COLOR SYSTEM
  // Pure Black & White. No greys, no accents. High contrast only.
  const colors = {
    dark: { primary: "#ffc53d" },
    light: { primary: "#000000" },
  }
  const { primary } = colors[theme]

  // 3. THE "PLATFORM" ICON
  // Designed on a 24x24 pixel grid for mathematical purity.
  // The shape is 18px wide x 17px high (Optical Square).
  // Stroke width is 3px (Matches font-weight 600).
  const IconMark = () => (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Unprice Logo"
    >
      {/* Left Pillar */}
      <rect x="3" y="4" width="3" height="16" fill={primary} />
      {/* Right Pillar */}
      <rect x="18" y="4" width="3" height="16" fill={primary} />
      {/* The Foundation (Bottom) */}
      <rect x="3" y="17" width="18" height="3" fill={primary} />
    </svg>
  )

  // 4. THE WORDMARK
  // Uses system fonts to feel native (San Francisco/Inter).
  // Tracking is tight (-0.03em) for authority.
  const Wordmark = () => (
    <span
      style={{
        fontSize: `${text}px`,
        color: primary,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        fontWeight: 600, // Matches the 3px stroke of the icon
        letterSpacing: "-0.03em", // Tight tracking for "Tech" feel
        lineHeight: 1,
      }}
    >
      unprice
    </span>
  )

  if (variant === "icon") {
    return (
      <div className={cn("flex", className)}>
        <IconMark />
      </div>
    )
  }

  if (variant === "wordmark") {
    return (
      <div className={className}>
        <Wordmark />
      </div>
    )
  }

  return (
    <div className={cn("flex items-center", className)} style={{ gap: `${gap}px` }}>
      <IconMark />
      <Wordmark />
    </div>
  )
}

// When the logo is Black on White (inverted), it visually "shrinks."
// We increase the stroke weight by ~15% (3px -> 3.5px) to compensate.
export function UnpriceFavicon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Solid White Background */}
      <rect width="32" height="32" rx="4" fill="#FFFFFF" />

      {/* Black Symbol with Thicker Stroke (Optical Compensation) */}
      <g fill="#000000">
        {/* Left - Thicker (4px vs 3px) */}
        <rect x="4" y="5" width="4" height="22" />
        {/* Right - Thicker */}
        <rect x="24" y="5" width="4" height="22" />
        {/* Bottom - Thicker */}
        <rect x="4" y="23" width="24" height="4" />
      </g>
    </svg>
  )
}
