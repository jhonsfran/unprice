"use client"

import { m, useInView } from "framer-motion"
import { BarChart, Code, DollarSign, TrendingUp } from "lucide-react"
import { useRef } from "react"
import { AnimatedBeamDemo } from "./animated-beam-demo"

const PillarsOfPriceOps = [
  {
    title: "Spend Safety",
    icon: <DollarSign className="h-5 w-5" />,
    description:
      "Put a real-time budget around your most expensive action. Reject over-budget customer or workload spend in the request path, before the work runs.",
    practice: "Stop the cost before it's created.",
  },
  {
    title: "Runtime Control",
    icon: <TrendingUp className="h-5 w-5" />,
    description:
      "Pricing is a runtime decision, not a page or an end-of-cycle job. Check access and consume usage while the request is still in flight.",
    practice: "Decide while the request is in flight.",
  },
  {
    title: "Explainable Money Path",
    icon: <BarChart className="h-5 w-5" />,
    description:
      "Usage, entitlements, budgets, credits, and invoices share one evidence trail. Trace every charge back to rated events and ledger captures.",
    practice: "Every charge has evidence.",
  },
  {
    title: "Open & Inspectable",
    icon: <Code className="h-5 w-5" />,
    description:
      "Monetization is too critical to be a black box. Build on an open AGPL-core: transparent, auditable, and owned by you.",
    practice: "Your revenue engine should be auditable and programmable.",
  },
]

export default function PillarsPriceOps() {
  const sectionRef = useRef(null)
  const isInView = useInView(sectionRef, { once: true, margin: "-100px" })

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.15,
        delayChildren: 0.1,
      },
    },
  }

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.3,
        ease: "easeOut",
      },
    },
  }

  return (
    <m.section
      ref={sectionRef}
      initial="hidden"
      animate={isInView ? "visible" : "hidden"}
      variants={containerVariants}
      aria-labelledby="benefits-title"
      className="mx-auto mt-28 px-4"
    >
      <m.h2
        variants={itemVariants}
        id="benefits-title"
        className="inline-block py-2 font-bold text-4xl text-background-textContrast tracking-tighter md:text-6xl"
      >
        The Solution: PriceOps
      </m.h2>
      <m.div variants={itemVariants} className="mt-6 text-justify text-lg">
        Unprice is open-source <b>PriceOps infrastructure</b> for usage-based SaaS. It’s the runtime
        layer that moves pricing out of your codebase and into the request path.
        <br />
        <br />
        <b>What is PriceOps?</b>
        <br />
        PriceOps is the practice of operating pricing as live infrastructure — metering,
        entitlements, budgets, credits, and invoice evidence run as one inspectable system in the
        request path, the way DevOps operates deploys and FinOps operates cloud spend.
        <br />
        <br />
        <b>Why PriceOps Matters?</b>
        <br />
        <ul className="my-4 list-disc pl-10">
          <li>
            <span className="font-semibold">Spend safety:</span> reject over-budget customer or
            workload spend before the expensive work runs, not after the invoice.
          </li>
          <li>
            <span className="font-semibold">Runtime decisions:</span> check entitlement and budget
            while the request is in flight, across usage-based, tiered, and hybrid models.
          </li>
          <li>
            <span className="font-semibold">Explainable money path:</span> trace every charge back
            to rated usage events and ledger captures from one evidence trail.
          </li>
        </ul>
        <br />
        Stop treating pricing as a Secondary Artifact.
        <br />
        <br />
        <b>For usage-based SaaS, pricing is a runtime decision.</b>
      </m.div>

      <m.div variants={itemVariants} className="my-28 flex justify-center">
        <AnimatedBeamDemo />
      </m.div>

      <m.dl
        variants={itemVariants}
        className="mt-8 grid grid-cols-4 gap-x-10 gap-y-8 sm:mt-12 sm:gap-y-10"
      >
        {PillarsOfPriceOps.map((pillar) => (
          <div key={pillar.title} className="col-span-4 sm:col-span-2 lg:col-span-1">
            <dt className="flex items-center gap-2 font-semibold text-primary-text">
              {pillar.icon}
              {pillar.title}
            </dt>
            <dd className="mt-2 leading-7">{pillar.description}</dd>
            <dd className="mt-2 font-semibold text-muted-foreground text-sm italic leading-7">
              &quot;{pillar.practice}&quot;
            </dd>
          </div>
        ))}
      </m.dl>
    </m.section>
  )
}
