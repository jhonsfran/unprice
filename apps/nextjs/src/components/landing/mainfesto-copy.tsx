"use client"

import { motion, useInView } from "framer-motion"
import { useRef } from "react"

export default function MainfestoCopy() {
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
        Static Pricing is a Revenue Leak
      </motion.h2>
      <motion.div variants={itemVariants} className="mt-6 text-justify text-lg">
        Most SaaS companies are accidentally leaving 30-50% of their revenue on the table.
        <br />
        <br />
        Why? Because they treat pricing like a backend config file instead of a growth lever.
        <br />
        <br />
        <b>The Old Way:</b> You have a "Pro" plan. It’s been $49/mo for two years. Your product is
        10x better than it was, but your price is the same. You want to test a usage-based tier, but
        the engineering team says it’ll take 6 weeks to rebuild the billing logic. So you do
        nothing. You lose.
        <br />
        <br />
        <b>The New Way: PriceOps.</b>
        <br />
        <br />
        Pricing should be as agile as your code. When your customers demand more value, you should
        be able to capture that value instantly—without opening a single JIRA ticket.
        <br />
        <br />
        The market has shifted. Customers no longer want to pay for "seats" they don't use. They
        want to pay for <b>value.</b>
        <br />
        <br />
        Think about it: Why do users churn?
        <br />
        <br />
        Usually, it’s a mismatch between what they pay and the value they get. In the "Static
        World," you have to guess the right price for everyone. In the "Adaptive World," the price
        fits the user like a glove.
        <br />
        <br />
        Companies using hybrid models (subscription + usage) see <b>21% higher growth rates</b> than
        those stuck in the past.
        <br />
        <br />
        Price is the direct mirror of your innovation. If your product is evolving daily, but your
        pricing reviews happen once a year, you aren't running a business—you're running a charity.
        <br />
        <br />
        Are you ready to stop leaking revenue?
      </motion.div>
      <motion.div variants={itemVariants} className="mt-6 text-justify text-lg">
        Are you ready for the shift?
        <br />
        <br />
        Let’s be honest—most SaaS companies aren’t:
        <br />
        <br />
        <ul className="list-disc pl-10">
          <li>You’re unsure what your users are truly willing to pay.</li>
          <li>You lack the tools to adapt pricing as quickly as your product evolves.</li>
          <li>You treat pricing as a backend config, not a growth engine.</li>
          <li>You don’t know how to price for different customer segments.</li>
        </ul>
      </motion.div>
      <motion.div variants={itemVariants} className="mt-6 text-justify text-lg">
        The companies winning today are those who treat pricing as a product, not an afterthought.
        <br />
        <br />
        Are you ready to join them?
      </motion.div>
    </motion.section>
  )
}
