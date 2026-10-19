import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The operating model, named. PriceOps is explained the way the brand doc
// defines it — versioned commercial infrastructure — with each pillar carrying
// its practice as a ledger fact instead of an icon card.

const pillars = [
  {
    title: "Spend safety",
    body: "Unprice rejects over-budget spend before the work runs.",
    practice: "stop cost before it exists",
  },
  {
    title: "Runtime decisions",
    body: "Unprice checks entitlements, budgets, and credits during the request.",
    practice: "decide during the request",
  },
  {
    title: "Explainable charges",
    body: "Every charge traces back to the usage and ledger entries behind it.",
    practice: "every charge carries evidence",
  },
  {
    title: "Open and inspectable",
    body: "Read the code that moves your money, or have your coding agent review it.",
    practice: "read it before you trust it",
  },
]

export default function ManifestoPriceOps() {
  return (
    <SectionShell labelledBy="priceops-title">
      <div className="flex flex-col items-start">
        <StationHeader index="02" label="The operating model" fact="PriceOps" />
        <h2
          id="priceops-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Run pricing like infrastructure.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          PriceOps means treating pricing as versioned infrastructure. You can change a plan without
          changing product code.
        </p>
      </div>

      <div className="relative mt-14">
        <span
          aria-hidden
          className="absolute top-[4px] left-0 hidden h-px w-full bg-background-border sm:block"
        />
        <ol className="grid gap-10 sm:grid-cols-2 sm:gap-8 lg:grid-cols-4">
          {pillars.map((pillar, index) => (
            <li key={pillar.title} className="relative flex flex-col sm:pt-6">
              <span
                aria-hidden
                className="-translate-y-1/2 absolute top-[4px] left-0 hidden size-[9px] rounded-full border border-background-borderHover bg-background-base sm:block"
              />
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[15px] text-background-text">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="font-medium text-background-textContrast text-lg">{pillar.title}</h3>
              </div>
              <p className="mt-3 flex-1 text-background-text text-sm leading-6">{pillar.body}</p>
              <p className="mt-6 border-background-border border-t pt-3 font-mono text-[11px] text-background-text">
                {pillar.practice}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </SectionShell>
  )
}
