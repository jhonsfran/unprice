"use client"
import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { m, useInView } from "framer-motion"
import { ChevronRight } from "lucide-react"
import Link from "next/link"
import { useRef } from "react"

export default function Belief() {
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
      aria-labelledby="vision-title"
      className="mx-auto mt-40 px-4"
    >
      <m.h2
        variants={itemVariants}
        id="features-title"
        className="inline-block py-2 font-bold text-4xl text-background-textContrast tracking-tighter md:text-6xl"
      >
        Our Belief
      </m.h2>
      <m.div variants={itemVariants} className="mt-6 space-y-4">
        <p className="text-justify text-lg leading-8">
          We believe the team that owns the request path should own pricing — without scattering
          revenue logic through product code.
          <br />
          <br />
          Black-box billing, after-the-fact metering, and plan logic frozen in your codebase are
          relics of a slower era. PriceOps is your control surface. Open source is your guarantee.
          <br />
          <br />
          We’re not here to tweak pricing around the edges.
          <br />
          We’re here to put the money decision where the cost is created: the request path.
          <br />
          <br />
          You shouldn’t need a deployment to change a price.
          <br />
          You shouldn’t discover an over-budget customer at invoice time.
          <br />
          You shouldn’t reconstruct a disputed charge by hand.
          <br />
          <br />
          Stop runaway usage before it runs. Explain every invoice from the same money path. Build on
          code you can read, at any scale.
          <br />
          <br />
          <span className="font-bold italic">
            For usage-based SaaS, pricing is a runtime decision. We’re here to make that the default.
          </span>
          <br />
          <br />
          <span className="font-bold italic">Unprice — open-source PriceOps infrastructure.</span>
        </p>
      </m.div>
      <m.div
        className="mx-auto mt-20 flex w-fit justify-center p-1.5"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.6 }}
      >
        <Link href={`${APP_DOMAIN}`} className={buttonVariants({ variant: "primary" })}>
          Start pricing
          <ChevronRight className="ml-1 h-4 w-4" />
        </Link>
      </m.div>
    </m.section>
  )
}
