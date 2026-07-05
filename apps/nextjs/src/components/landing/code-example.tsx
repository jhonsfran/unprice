"use client"
import { DOCS_DOMAIN } from "@unprice/config"
import { Badge } from "@unprice/ui/badge"
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
      <m.div variants={itemVariants}>
        <Badge variant="outline" className="w-fit">
          First integration
        </Badge>
      </m.div>
      <m.h2
        variants={itemVariants}
        id="developers-title"
        className="mt-4 inline-block bg-clip-text py-2 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-6xl"
      >
        The first request path is deliberately small.
      </m.h2>
      <m.div variants={itemVariants} className="mt-6 text-justify text-lg">
        Define one plan version, provision or map one customer, then run `access.check` next to the
        code you already trust. Nothing has to block production traffic on day one.
        <br />
        <br />
        Once the decision matches the evidence, switch to `usage.consume` for synchronous
        enforcement or `runs.*` for budgeted workflows. The same path that denies over-budget work
        keeps the invoice explanation.
        <br />
        <br />
        <div className="flex justify-end">
          <Link
            href={`${DOCS_DOMAIN}`}
            target="_blank"
            className={buttonVariants({ variant: "primary" })}
          >
            Explore the SDK
            <ChevronRight data-icon="inline-end" />
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
