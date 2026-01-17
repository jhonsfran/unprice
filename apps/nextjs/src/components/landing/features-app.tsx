"use client"

import { motion } from "framer-motion"

const stats = [
  {
    name: "Edge Entitlements",
    value: "<100ms",
  },
  {
    name: "Event Processing",
    value: "100k+/s",
  },
  {
    name: "Uptime Target",
    value: "99.9%",
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
      duration: 0.5,
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
    <motion.section
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-100px" }}
      variants={containerVariants}
      aria-labelledby="features-title"
      className="mx-auto w-full max-w-4xl px-4 py-10"
    >
      <motion.h2
        variants={itemVariants}
        id="features-title"
        className="mt-2 inline-block bg-clip-text py-2 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-6xl"
      >
        Built for Mission-Critical Revenue
      </motion.h2>

      <motion.p
        variants={itemVariants}
        className="mt-6 max-w-3xl text-justify text-background-text text-lg leading-7"
      >
        PriceOps isn't just about strategy—it's about performance. Your monetization layer shouldn't
        be a bottleneck. Unprice is architected to handle high-volume event metering and low latency
        entitlement checks at the edge.
      </motion.p>

      <motion.dl
        variants={statsContainerVariants}
        className="mt-12 grid grid-cols-1 gap-y-8 md:grid-cols-3 md:border-y md:py-14"
      >
        {stats.map((stat, index) => (
          <motion.div
            key={index.toString()}
            variants={itemVariants}
            className="border-l-2 pl-6 md:border-l md:text-center lg:border-background-border lg:first:border-none"
          >
            <motion.dd className="inline-block bg-clip-text font-bold text-4xl text-primary-text tracking-tight lg:text-5xl">
              {stat.value}
            </motion.dd>
            <motion.dt className="mt-1 font-medium text-background-textContrast">
              {stat.name}
            </motion.dt>
          </motion.div>
        ))}
      </motion.dl>
    </motion.section>
  )
}
