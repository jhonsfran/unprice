"use client"
import { BASE_URL } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { motion, useInView } from "framer-motion"
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
        duration: 0.5,
        ease: "easeOut",
      },
    },
  }

  return (
    <motion.section
      ref={sectionRef}
      initial="hidden"
      animate={isInView ? "visible" : "hidden"}
      variants={containerVariants}
      aria-labelledby="code-example-title"
      className="mx-auto w-full max-w-4xl px-4 py-10"
    >
      <motion.h2
        variants={itemVariants}
        id="features-title"
        className="mt-2 inline-block bg-clip-text py-2 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-6xl"
      >
        PriceOps Infrastructure
      </motion.h2>
      <motion.div variants={itemVariants} className="mt-6 text-justify text-lg">
        SaaS pricing was built for a world that no longer exists. Three tiers, feature gating,
        quarterly pricing reviews.
        <br />
        <br />
        That world is over.
        <br />
        <br />
        Today, your users expect personalized value. Your product ships changes daily. But you're
        still pricing like it's 2010 — Static plans, gut feelings, and hardcoded logic.
        <br />
        <br />
        We believe pricing is the most neglected growth lever in SaaS. It's time to stop waiting on
        engineering and start iterating on revenue.
        <div className="mt-10 flex justify-end">
          <Link href={`${BASE_URL}/manifesto`}>
            <Button variant="outline">Read the Manifesto</Button>
          </Link>
        </div>
      </motion.div>
    </motion.section>
  )
}
