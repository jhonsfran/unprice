"use client"
import { BASE_URL } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { m, useInView } from "framer-motion"
import Link from "next/link"
import { useRef } from "react"

export default function PriceOpsSection() {
  const sectionRef = useRef(null)
  const isInView = useInView(sectionRef, { once: true, margin: "-100px" })

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.2,
        delayChildren: 0.3,
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
      aria-labelledby="runtime-decision-title"
      className="mx-auto w-full max-w-6xl px-6 py-16"
    >
      <m.h2
        variants={itemVariants}
        id="runtime-decision-title"
        className="mt-2 inline-block bg-clip-text py-2 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-6xl"
      >
        Pricing is a runtime decision
      </m.h2>
      <m.div variants={itemVariants} className="mt-6 text-justify text-lg">
        For usage-based products, pricing is not a page or an end-of-cycle invoice job. By the time
        billing runs, the expensive work already happened: the LLM call, the data job, the costly
        API, the multi-minute workflow.
        <br />
        <br />
        You know the friction: usage tables, Redis counters, cron reconciliation, and plan logic
        scattered across product code. When a customer or workload runs over budget, the cost is
        already created — and a disputed invoice means tracing the path from event to counter to
        billing line by hand.
        <br />
        <br />
        PriceOps treats pricing as live infrastructure. Unprice puts the decision in the request
        path: check entitlement, check budget, reserve credits, and reject over-budget work before
        it runs — then explain every invoice line from the same money path.
        <br />
        <br />
        Stop treating revenue as a config file. Decide whether expensive usage should happen at all,
        before it costs you money.
        <div className="mt-10 flex justify-end">
          <Link href={`${BASE_URL}/manifesto`}>
            <Button variant="outline">Read more</Button>
          </Link>
        </div>
      </m.div>
    </m.section>
  )
}
