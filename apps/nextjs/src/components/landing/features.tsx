import { CalendarIcon, FileTextIcon } from "lucide-react"
import { BellIcon, Share2Icon } from "lucide-react"

import { DOCS_DOMAIN } from "@unprice/config"
import { Badge } from "@unprice/ui/badge"
import { Calendar } from "@unprice/ui/calendar"
import { cn } from "@unprice/ui/utils"
import { AnimatedBeamDemo } from "./animated-beam-demo"
import { AnimatedListDemo } from "./animated-list-demo"
import { BentoCard, BentoGrid } from "./bento-grid"
import { Marquee } from "./marquee"

const files = [
  {
    name: "FREE",
    body: "Unprice is open source under AGPL-3.0 and free to self-host. Meter usage and enforce budgets from day one.",
  },
  {
    name: "PRO",
    body: "Unprice Pro adds a commercial license and support for teams running pricing in production.",
  },
  {
    name: "ENTERPRISE",
    body: "Unprice Enterprise adds dedicated support for teams that can't open-source their changes.",
  },
]

const features = [
  {
    Icon: FileTextIcon,
    name: "Versioned plans",
    description: "Pin customers to the plan version they bought while new packaging ships safely.",
    href: `${DOCS_DOMAIN}/features/plans`,
    cta: "Learn more",
    className: "col-span-3 lg:col-span-1",
    background: (
      <Marquee
        pauseOnHover
        className="absolute top-10 [--duration:20s] [mask-image:linear-gradient(to_top,transparent_40%,#000_100%)] "
      >
        {files.map((f, idx) => (
          <figure
            key={idx.toString()}
            className={cn(
              "relative w-32 cursor-pointer overflow-hidden rounded-xl border p-4",
              "border-background-border bg-background-base hover:bg-background-base/50",
              "transform-gpu blur-[1px] transition-all duration-300 ease-out hover:blur-none"
            )}
          >
            <div className="flex flex-row items-center gap-2">
              <div className="flex flex-col">
                <figcaption className="font-medium text-sm">{f.name}</figcaption>
              </div>
            </div>
            <blockquote className="mt-2 text-xs">{f.body}</blockquote>
          </figure>
        ))}
      </Marquee>
    ),
  },
  {
    Icon: BellIcon,
    name: "Right runtime call",
    description: "Use record for evidence, consume for enforcement, and runs for reserved budgets.",
    href: `${DOCS_DOMAIN}/concepts/pricing/overview`,
    cta: "Learn more",
    className: "col-span-3 lg:col-span-2",
    background: (
      <AnimatedListDemo className="absolute top-4 right-2 h-[300px] w-full scale-75 border-none transition-all duration-300 ease-out [mask-image:linear-gradient(to_top,transparent_10%,#000_100%)] group-hover:scale-90" />
    ),
  },
  {
    Icon: Share2Icon,
    name: "Invoice evidence",
    description:
      "Trace charges back to pricing rules, rated usage, wallet movement, and ledger evidence.",
    href: `${DOCS_DOMAIN}/features/analytics`,
    cta: "Learn more",
    className: "col-span-3 lg:col-span-2",
    background: (
      <AnimatedBeamDemo className="absolute top-4 right-2 h-[300px] border-none transition-all duration-300 ease-out [mask-image:linear-gradient(to_top,transparent_10%,#000_100%)] group-hover:scale-105" />
    ),
  },
  {
    Icon: CalendarIcon,
    name: "Provisioned entitlements",
    description:
      "Create the customer, subscription, billing period, wallet, and entitlements in one path.",
    className: "col-span-3 lg:col-span-1",
    href: `${DOCS_DOMAIN}/features/subscriptions`,
    cta: "Learn more",
    background: (
      <Calendar
        mode="single"
        selected={new Date(2022, 4, 11, 0, 0, 0)}
        className="absolute top-10 right-0 origin-top scale-75 rounded-md border transition-all duration-300 ease-out [mask-image:linear-gradient(to_top,transparent_40%,#000_100%)] group-hover:scale-90"
      />
    ),
  },
]

export const Features = () => {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-16">
      <Badge variant="outline" className="w-fit">
        Capabilities
      </Badge>
      <h2
        id="capabilities-title"
        className="mt-4 inline-block bg-clip-text py-2 pb-8 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-6xl"
      >
        One runtime after the first action proves it.
      </h2>
      <BentoGrid>
        {features.map((feature, idx) => (
          <BentoCard key={idx.toString()} {...feature} />
        ))}
      </BentoGrid>
    </div>
  )
}
