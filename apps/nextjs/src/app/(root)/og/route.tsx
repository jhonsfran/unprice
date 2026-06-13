import { ImageResponse } from "@vercel/og"
import { siteConfig } from "~/constants/layout"

export const runtime = "edge"

// Simplified Logo for Satori (no filters)
const SimpleLogo = ({ size = 80, color = "#ffc53d" }: { size?: number; color?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Unprice Logo"
  >
    {/* Left Pillar */}
    <rect x="3" y="4" width="3" height="16" fill={color} />
    {/* Right Pillar */}
    <rect x="18" y="4" width="3" height="16" fill={color} />
    {/* The Foundation (Bottom) */}
    <rect x="3" y="17" width="18" height="3" fill={color} />
  </svg>
)

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const title = searchParams.get("title") || siteConfig.name
  const description =
    searchParams.get("description") ||
    "Unprice, PriceOps infrastructure for SaaS. Stop hardcoding your revenue."
  const rawLogoUrl = searchParams.get("logo")

  // Validate logoUrl is HTTPS and optionally from trusted domains
  let logoUrl: string | null = null
  if (rawLogoUrl) {
    try {
      const url = new URL(rawLogoUrl)
      if (url.protocol === "https:") {
        logoUrl = rawLogoUrl
      }
    } catch {
      // Invalid URL, ignore
    }
  }

  // Load font from local assets
  const font = await fetch(new URL("../../../assets/fonts/Geist-Bold.ttf", import.meta.url)).then(
    (res) => res.arrayBuffer()
  )

  if (!font) {
    return new Response("Failed to load fonts for OG image generation.", { status: 500 })
  }

  // Default Pluto landing page OG image
  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#111110",
        backgroundImage:
          "radial-gradient(circle at 25px 25px, #222221 2%, transparent 0%), radial-gradient(circle at 75px 75px, #222221 2%, transparent 0%)",
        backgroundSize: "100px 100px",
        color: "white",
        fontSize: 100,
        fontWeight: 900,
        fontFamily: "Geist",
      }}
    >
      {/* Header with logo area */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: "40px",
          gap: "12px",
        }}
      >
        {logoUrl ? (
          <img
            src={logoUrl}
            alt="Logo"
            style={{ width: "80px", height: "80px", borderRadius: "12px", objectFit: "contain" }}
          />
        ) : (
          <SimpleLogo size={80} color="#ffc53d" />
        )}
        <span
          style={{
            fontSize: "60px",
            fontWeight: 600,
            color: "#ffc53d",
            letterSpacing: "-0.03em",
            lineHeight: 1,
            textTransform:
              title.toLowerCase() === siteConfig.name.toLowerCase() ? "lowercase" : "none",
          }}
        >
          {title}
        </span>
      </div>

      {/* Description */}
      <div
        style={{
          fontSize: "32px",
          color: "#a1a1aa",
          textAlign: "center",
          maxWidth: "800px",
          lineHeight: "1.3",
          marginBottom: "40px",
        }}
      >
        {description}
      </div>

      {/* Feature highlights - only show for Unprice main site */}
      {!logoUrl && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "40px",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              backgroundColor: "#222221",
              padding: "16px 24px",
              borderRadius: "12px",
              border: "1px solid #374151",
            }}
          >
            <span style={{ fontSize: "24px", marginRight: "12px" }}>📊</span>
            <span style={{ fontSize: "20px", color: "#e5e7eb" }}>Track usage</span>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              backgroundColor: "#222221",
              padding: "16px 24px",
              borderRadius: "12px",
              border: "1px solid #374151",
            }}
          >
            <span style={{ fontSize: "24px", marginRight: "12px" }}>💸</span>
            <span style={{ fontSize: "20px", color: "#e5e7eb" }}>Iterate prices</span>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              backgroundColor: "#222221",
              padding: "16px 24px",
              borderRadius: "12px",
              border: "1px solid #374151",
            }}
          >
            <span style={{ fontSize: "24px", marginRight: "12px" }}>⚡</span>
            <span style={{ fontSize: "20px", color: "#e5e7eb" }}>Real-time insights</span>
          </div>
        </div>
      )}

      {/* Footer with subtle branding */}
      <div
        style={{
          position: "absolute",
          bottom: "40px",
          fontSize: "18px",
          color: "#6b7280",
        }}
      >
        Powered by Unprice
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: "Geist",
          data: font,
          style: "normal",
        },
      ],
    }
  )
}
