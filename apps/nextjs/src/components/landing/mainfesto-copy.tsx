"use client"

import { m, useInView } from "framer-motion"
import { useRef } from "react"

export default function MainfestoCopy() {
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
      aria-labelledby="code-example-title"
      className="mx-auto w-full max-w-4xl px-4 py-10"
    >
      <m.h2
        variants={itemVariants}
        id="features-title"
        className="mt-2 inline-block bg-clip-text py-2 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-6xl"
      >
        By invoice time, the expensive work already ran
      </m.h2>
      <m.div variants={itemVariants} className="mt-6 text-justify text-lg">
        For usage-based products, pricing is not a static configuration. It’s a decision your app has
        to make while the request is still in flight.
        <br />
        <br />
        <b>The trap:</b> a customer triggers your most expensive action — an LLM call, a data job, a
        costly API, a multi-minute workflow. Your usage tables, Redis counters, and cron
        reconciliation only notice later. By then the cost is created. If the customer disputes the
        invoice, you reconstruct the path from event to counter to billing line by hand.
        <br />
        <br />
        <b>The PriceOps Way:</b>
        <br />
        <br />
        Pricing runs in the request path. Check entitlement, check budget, reserve credits, and
        reject over-budget work before it runs — then explain every charge from the same usage trail.
        <br />
        <br />
        The market demands this shift. Usage-based and AI products can’t let a single customer or
        workload turn into <b>uncapped cost.</b>
        <br />
        <br />
        Why do margins slip? Often it’s the gap between when usage happens and when pricing reacts. In
        a static system, you find out at invoice time. In a runtime system, you decide before the
        cost exists.
        <br />
        <br />
        Price is where your product meets your margin. If your product ships daily but pricing only
        reacts at invoice time, you’re carrying a hidden margin risk.
        <br />
        <br />
        Stop the leak.
      </m.div>
      <m.div variants={itemVariants} className="mt-6 text-justify text-lg">
        Recognize the signs of static, after-the-fact pricing:
        <br />
        <br />
        <ul className="list-disc pl-10">
          <li>No way to stop over-budget usage before it runs.</li>
          <li>Inability to change packaging without rewriting product code.</li>
          <li>Treating pricing as a backend config, not a runtime decision.</li>
          <li>Invoice disputes that take manual reconstruction to explain.</li>
        </ul>
      </m.div>
      <m.div variants={itemVariants} className="mt-6 text-justify text-lg">
        The teams winning today treat pricing as runtime infrastructure, not a Secondary Artifact.
        <br />
        <br />
        Are you ready to join them?
      </m.div>
    </m.section>
  )
}
