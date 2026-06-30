"use client"
import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { m, useInView } from "framer-motion"
import { BarChart, Check, ChevronRight, Code, Settings } from "lucide-react"
import { Link } from "next-view-transitions"
import { useRef } from "react"
import { SDKDemo } from "./sdk-examples"

const features = [
  {
    name: "Configure",
    description: "Create and manage your plans, features, and tiers from the Dashboard.",
    icon: Settings,
  },
  {
    name: "Use SDK",
    description: "Use our SDK in your project. Start incrementally.",
    icon: Code,
  },
  {
    name: "Verify and report",
    description: "Check entitlements, report usage, and budget expensive runs before they execute.",
    icon: Check,
  },
  {
    name: "Usage evidence",
    description: "Trace every charge back to rated usage events and ledger captures.",
    icon: BarChart,
  },
]

export default function CodeExample() {
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
      aria-labelledby="code-example-title"
      className="mx-auto w-full max-w-6xl px-6 py-16"
    >
      <m.h2
        variants={itemVariants}
        id="developers-title"
        className="mt-2 inline-block bg-clip-text py-2 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-6xl"
      >
        Built by developers, <br /> for developers
      </m.h2>
      <m.div variants={itemVariants} className="mt-6 text-justify text-lg">
        You own the request path, so you should own pricing without scattering revenue logic through
        product code. Unprice gives you a single integration: meter usage, check entitlements, budget
        expensive runs, and reserve credits — then change packaging without rewriting the money path.
        <br />
        <br />
        When pricing logic lives in one inspectable runtime instead of your codebase, you can stop
        over-budget work before it runs and explain any invoice line from the same usage trail. Your
        code stays clean. Your margins stay protected.
        <br />
        <br />
        <div className="flex justify-end">
          <Link href={`${APP_DOMAIN}`} className={buttonVariants({ variant: "primary" })}>
            {" "}
            Start pricing
            <ChevronRight className="ml-1 h-4 w-4" />
          </Link>
        </div>
      </m.div>

      <m.div variants={itemVariants}>
        <SDKDemo />
      </m.div>
      <m.dl variants={containerVariants} className="mt-24 grid grid-cols-4 gap-10">
        {features.map((item) => (
          <m.div
            key={item.name}
            variants={itemVariants}
            className="col-span-full sm:col-span-2 lg:col-span-1"
          >
            <div className="flex items-center gap-2 align-middle text-primary-text">
              <item.icon aria-hidden="true" className="size-6" />
              <dt className="font-semibold">{item.name}</dt>
            </div>
            <dd className="mt-2 text-background-text leading-7">{item.description}</dd>
          </m.div>
        ))}
      </m.dl>
    </m.section>
  )
}
