"use client"

import { m } from "framer-motion"
import { MoneyPath } from "./money-path"

const stats = [
  {
    name: "Entitlement & budget checks",
    value: "Request-path",
  },
  {
    name: "Reject over-budget work",
    value: "Pre-spend",
  },
  {
    name: "AGPL-3.0 + commercial",
    value: "Open-core",
  },
]

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.2,
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

const statsContainerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
      delayChildren: 0.3,
    },
  },
}

export function FeaturesApp() {
  return (
    <m.section
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-100px" }}
      variants={containerVariants}
      aria-labelledby="request-path-title"
      className="mx-auto w-full max-w-6xl px-6 py-16"
    >
      <m.h2
        variants={itemVariants}
        id="request-path-title"
        className="mt-2 inline-block bg-clip-text py-2 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-6xl"
      >
        Built for the request path
      </m.h2>

      <m.p
        variants={itemVariants}
        className="mt-6 text-justify text-background-text text-lg leading-7"
      >
        PriceOps isn't only about strategy — it's about where the decision happens. Your
        monetization layer should run where the cost is created: in the request path, before
        expensive work executes. Unprice checks entitlement and budget, reserves credits, and
        rejects over-budget work in line, then keeps the evidence to explain the invoice later.
      </m.p>

      <m.div variants={itemVariants} className="mt-12">
        <MoneyPath />
      </m.div>

      <m.dl
        variants={statsContainerVariants}
        className="mt-12 grid grid-cols-1 gap-y-8 md:grid-cols-3 md:border-y md:py-14"
      >
        {stats.map((stat, index) => (
          <m.div
            key={index.toString()}
            variants={itemVariants}
            className="border-l-2 pl-6 md:border-l md:text-center lg:border-background-border lg:first:border-none"
          >
            <m.dd className="inline-block bg-clip-text font-bold text-4xl text-primary-text tracking-tight lg:text-5xl">
              {stat.value}
            </m.dd>
            <m.dt className="mt-1 font-medium text-background-textContrast">{stat.name}</m.dt>
          </m.div>
        ))}
      </m.dl>
    </m.section>
  )
}
