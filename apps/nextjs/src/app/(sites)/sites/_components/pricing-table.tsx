"use client"

import { cn } from "@unprice/ui/utils"
import { motion } from "framer-motion"
import type React from "react"
import Balancer from "react-wrap-balancer"
import { PricingCard, type PricingPlan } from "./pricing-card"

export interface PricingTableProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string
  subtitle?: string
  plans: PricingPlan[]
  popularPlan: string
}

// Dynamic grid class based on number of plans
const getGridClass = (planCount: number) => {
  const gridClasses = {
    1: "grid-cols-1",
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
    5: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
  }
  return (
    gridClasses[planCount as keyof typeof gridClasses] ||
    "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
  )
}

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

const heroImageVariants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      type: "spring",
      stiffness: 100,
      damping: 20,
      delay: 0.6,
    },
  },
}

export function PricingTable({
  title = "Simple, Transparent Pricing",
  subtitle = "Choose the plan that's right for you",
  plans,
  className,
  popularPlan,
}: PricingTableProps) {
  // Ensure the popular plan is always in the middle
  // const reorderedPlans = React.useMemo(() => {
  //   const plansCopy = [...plans]
  //   const popularIndex = plansCopy.findIndex((plan) => plan.name === popularPlan)
  //   if (popularIndex === -1) return plansCopy
  //   const popular = plansCopy[popularIndex]
  //   if (!popular) return plansCopy
  //   plansCopy.splice(popularIndex, 1)
  //   const middleIndex = Math.floor(plansCopy.length / 2)
  //   plansCopy.splice(middleIndex, 0, popular)
  //   return plansCopy
  // }, [plans, popularPlan])

  return (
    <motion.div
      aria-labelledby="hero-title"
      className={cn("flex flex-col items-center justify-center text-center", className)}
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.h1
        id="hero-title"
        className="inline-block bg-clip-text p-2 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-7xl"
        variants={itemVariants}
      >
        <Balancer>{title}</Balancer>
      </motion.h1>
      <motion.div
        className="mt-6 max-w-2xl px-4 text-background-text text-lg md:px-0"
        variants={itemVariants}
      >
        {subtitle}
      </motion.div>
      <motion.div
        className="relative mx-auto mt-20 h-fit w-full max-w-6xl py-10 md:px-4"
        variants={heroImageVariants}
      >
        <section
          className={cn("grid gap-6", getGridClass(plans.length), {
            "mx-auto justify-center md:max-w-sm": plans.length === 1,
            "mx-auto justify-center md:max-w-2xl": plans.length === 2,
          })}
        >
          {plans.map((plan) => (
            <PricingCard
              key={plan.name}
              plan={plan}
              isPopular={plan.name === popularPlan}
              isOnly={plans.length === 1}
            />
          ))}
        </section>
      </motion.div>
    </motion.div>
  )
}
