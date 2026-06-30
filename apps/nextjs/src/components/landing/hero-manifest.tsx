"use client"

import { m } from "framer-motion"
import Balancer from "react-wrap-balancer"
import { UnpriceManifesto } from "./unprice-manifesto"

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
      type: "spring",
      stiffness: 100,
      damping: 20,
    },
  },
}

export default function HeroManifest() {
  return (
    <div>
      <m.section
        aria-labelledby="hero-title"
        className="mt-32 flex flex-col items-center justify-center text-center sm:mt-40"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <m.h1
          id="hero-title"
          className="inline-block p-2 font-bold text-2xl text-background-textContrast tracking-tighter sm:text-6xl md:text-7xl"
          variants={itemVariants}
        >
          <Balancer>Pricing is a runtime decision</Balancer>
        </m.h1>
        <m.p
          className="mt-20 max-w-2xl px-4 text-center text-background-text text-lg md:px-0"
          variants={itemVariants}
        >
          SaaS pricing was built for a static era. Hardcoded tiers, manual feature gating, and
          end-of-cycle invoices are relics. For usage-based products, that model breaks the moment
          usage gets expensive.
          <br />
          <br />
          <span className="font-bold italic">The market has already shifted.</span>
          <br />
          <br />
          Today a single customer, job, workflow, tool, or agent can cross a budget before anyone
          reaches the invoice. By the time billing runs, the expensive work already happened — and
          the cost is already created.
          <br />
          <br />
          Static pricing isn’t just outdated. It’s a margin risk you can’t see until the invoice.
          <br />
          <br />
          So pricing has to move into the request path: a{" "}
          <span className="font-bold italic">runtime decision</span> that stops expensive usage
          before it runs, not a static config.
        </m.p>
      </m.section>
      <UnpriceManifesto />
    </div>
  )
}
