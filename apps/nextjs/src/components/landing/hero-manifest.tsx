"use client"

import { motion } from "framer-motion"
import Balancer from "react-wrap-balancer"
import { UnpriceManifesto } from "./unprice-manifesto"

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
      type: "spring",
      stiffness: 100,
      damping: 20,
    },
  },
}

export default function HeroManifest() {
  return (
    <div>
      <motion.section
        aria-labelledby="hero-title"
        className="mt-32 flex flex-col items-center justify-center text-center sm:mt-40"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <motion.h1
          id="hero-title"
          className="inline-block p-2 font-bold text-2xl text-background-textContrast tracking-tighter sm:text-6xl md:text-7xl"
          variants={itemVariants}
        >
          <Balancer>PriceOps Infrastructure</Balancer>
        </motion.h1>
        <motion.p
          className="mt-20 max-w-2xl px-4 text-center text-background-text text-lg md:px-0"
          variants={itemVariants}
        >
          SaaS pricing was built for a world that no longer exists. Three tiers, feature gating,
          quarterly pricing reviews. That worked when AI wasn't a thing and buyers behaved
          predictably.
          <br />
          <br />
          <span className="font-bold italic">That world is over.</span>
          <br />
          <br />
          Today, your users expect personalized value. Your product ships changes daily. Your market
          is fragmented, dynamic, and ruthless. But you're still pricing like it's 2010 — Static
          plans. Gut feelings. Hardcoded logic.
          <br />
          <br />
          Static pricing isn’t just outdated. It’s revenue suicide.
          <br />
          <br />
          In a world where AI can clone your product overnight, pricing is your{" "}
          <span className="font-bold italic">sharpest weapon.</span>
        </motion.p>
      </motion.section>
      <UnpriceManifesto />
    </div>
  )
}
