import { ImageResponse } from "next/og"
import { siteConfig } from "~/constants/layout"

export const runtime = "edge"

// Brand bracket mark for Satori (no filters). Matches internal/ui/src/unprice.tsx:
// a pair of brackets in paper ink cradling the amber signal dot.
const BracketMark = ({ size = 80 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Unprice"
  >
    <path
      d="M13.5 6 L8 6 L8 26 L13.5 26"
      stroke="#fafafa"
      strokeWidth="3.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
    <path
      d="M18.5 6 L24 6 L24 26 L18.5 26"
      stroke="#fafafa"
      strokeWidth="3.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
    <circle cx="16" cy="16" r="3.3" fill="#ffc53d" />
  </svg>
)

const INK = "#fafafa"
const MUTED = "#a1a09a"
const RULE = "#2c2b29"
const DANGER = "#ff9592"
const AMBER = "#ffc53d"

// One row of the receipt: a label, a rule that carries the eye across, and
// the fact it resolves to.
function Row({
  label,
  fact,
  factColor = INK,
}: { label: string; fact: string; factColor?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        paddingTop: "14px",
        paddingBottom: "14px",
        borderBottom: `1px solid ${RULE}`,
      }}
    >
      <span style={{ fontSize: "24px", color: MUTED, letterSpacing: "0.14em" }}>{label}</span>
      <span style={{ fontSize: "28px", color: factColor }}>{fact}</span>
    </div>
  )
}

function DenialReceiptCard() {
  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: "#111110",
        backgroundImage:
          "radial-gradient(circle at 25px 25px, #222221 2%, transparent 0%), radial-gradient(circle at 75px 75px, #222221 2%, transparent 0%)",
        backgroundSize: "100px 100px",
        fontFamily: "Geist",
        padding: "64px 72px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <BracketMark size={44} />
          <span style={{ fontSize: "30px", color: INK, letterSpacing: "-0.02em" }}>unprice</span>
        </div>
        <span style={{ fontSize: "22px", color: MUTED, letterSpacing: "0.16em" }}>
          AGPL-3.0 · OPEN SOURCE
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <span
          style={{
            fontSize: "62px",
            color: INK,
            lineHeight: 1.1,
            letterSpacing: "-0.03em",
            maxWidth: "760px",
            paddingBottom: "18px",
          }}
        >
          Authorize customer spend before paid work runs.
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
        <Row label="REQUEST" fact="access.check" />
        <Row label="PRICE" fact="2,050 tokens × $0.002 = $4.10" />
        <Row label="BALANCE" fact="$1.80" factColor={AMBER} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
            paddingTop: "22px",
          }}
        >
          <span style={{ fontSize: "30px", color: DANGER }}>
            denied · before any cost was created
          </span>
          <span style={{ fontSize: "26px", color: DANGER, letterSpacing: "0.08em" }}>
            LIMIT_EXCEEDED
          </span>
        </div>
      </div>
    </div>
  )
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const title = searchParams.get("title") || siteConfig.name
  const description = searchParams.get("description") || siteConfig.description
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

  // The card the launch is actually seen through. On launch day this image is
  // viewed far more often than the page it links to, so it does the page's
  // job: the mechanism sentence (the same string as <title>, og:title and the
  // h1 — a reader has to land on what they clicked) over the one artifact no
  // adjacent system produces, a denial that cost nothing.
  //
  // Follow-up: the receipt grammar wants a monospace face for the fact
  // column. Only Geist-Bold is bundled for Satori today, so the rows carry
  // the grammar through tracking, rules and alignment instead. Drop a mono
  // TTF next to Geist-Bold and switch the `fact` styles to it.
  // Only the bare /og request — the landing card. Callers that pass their own
  // title (the manifesto) or a logo (customer-branded cards) keep the generic
  // layout below.
  if (!logoUrl && !searchParams.get("title") && !searchParams.get("description")) {
    return new ImageResponse(<DenialReceiptCard />, {
      width: 1200,
      height: 630,
      fonts: [{ name: "Geist", data: font, style: "normal" }],
    })
  }

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
          <BracketMark size={80} />
        )}
        <span
          style={{
            fontSize: "60px",
            fontWeight: 600,
            color: "#fafafa",
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

      {/* Money-path highlights - only show for Unprice main site */}
      {!logoUrl && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "24px",
            flexWrap: "wrap",
          }}
        >
          {["Meter usage", "Budget the request", "Explain the invoice"].map((label) => (
            <div
              key={label}
              style={{
                display: "flex",
                alignItems: "center",
                backgroundColor: "#222221",
                padding: "16px 24px",
                borderRadius: "12px",
                border: "1px solid #2c2b29",
              }}
            >
              <span style={{ fontSize: "22px", color: "#e5e7eb" }}>{label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Attribution footer — customer-branded cards only, never our own */}
      {logoUrl && (
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
      )}
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
