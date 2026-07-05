"use client"

import { APP_DOMAIN, DOCS_DOMAIN } from "@unprice/config"
import { Badge } from "@unprice/ui/badge"
import { Button, buttonVariants } from "@unprice/ui/button"
import { ChevronRight, GitHub } from "@unprice/ui/icons"
import { m } from "framer-motion"
import { useTheme } from "next-themes"
import Link from "next/link"
import Balancer from "react-wrap-balancer"
import { useMounted } from "~/hooks/use-mounted"
import { MoneyPath } from "./money-path"
import { WordRotate } from "./text-effects"

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.2,
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

const proofItems = ["Shadow first", "Sandbox before money", "Your own Stripe", "AGPL-3.0 core"]

const trustChecks = [
  {
    label: "Read-only shadow",
    value: "access.check",
  },
  {
    label: "No real processor",
    value: "Sandbox",
  },
  {
    label: "Funds stay yours",
    value: "Own Stripe",
  },
]

export default function Hero() {
  const { resolvedTheme } = useTheme()
  const isMounted = useMounted()

  return (
    <m.section
      aria-labelledby="hero-title"
      className="relative mx-auto flex min-h-[calc(100svh-4rem)] w-full max-w-6xl flex-col items-center justify-start px-5 pt-12 pb-10 text-center sm:min-h-[calc(100vh-4rem)] sm:justify-center sm:px-6 sm:pt-20 sm:pb-16"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <m.div
        className="mb-3 flex flex-wrap items-center justify-center gap-x-2 text-background-text text-base sm:mb-4 sm:text-xl"
        variants={itemVariants}
      >
        Your product is smart, but your pricing is{" "}
        {isMounted && (
          <WordRotate
            className="italic"
            words={["hardcoded", "brittle", "static", "manual"]}
            shadowColor={resolvedTheme === "dark" ? "white" : "black"}
          />
        )}
      </m.div>
      <m.h1
        id="hero-title"
        className="inline-block max-w-5xl bg-clip-text p-2 font-bold text-4xl text-background-textContrast leading-[1.05] sm:text-6xl md:text-7xl"
        variants={itemVariants}
      >
        <Balancer>Authorize customer spend before paid work runs.</Balancer>
      </m.h1>
      <m.p
        className="mx-auto mt-4 max-w-3xl text-background-text text-base leading-7 sm:mt-6 sm:text-lg sm:leading-8"
        variants={itemVariants}
      >
        <Balancer>
          <span className="sm:hidden">
            Start with one paid action in one afternoon: shadow it, prove it on Sandbox, then
            enforce only when the evidence matches.
          </span>
          <span className="hidden sm:inline">
            Unprice is the open-source customer money path for usage-based SaaS. Start with one paid
            action in one afternoon: define the plan version, install the SDK, run the decision in
            shadow, and prove the path on Sandbox before you enforce anything.
          </span>
        </Balancer>
      </m.p>

      <m.div className="mt-5 flex flex-wrap justify-center gap-2 sm:mt-6" variants={itemVariants}>
        {proofItems.map((item) => (
          <Badge key={item} variant="outline">
            {item}
          </Badge>
        ))}
      </m.div>

      <m.div
        className="mt-6 flex w-full flex-col justify-center gap-3 align-middle sm:mt-10 sm:flex-row"
        variants={itemVariants}
      >
        <Link href={`${APP_DOMAIN}`} className={buttonVariants({ variant: "primary" })}>
          Start with one paid action
          <ChevronRight data-icon="inline-end" />
        </Link>
        <Link
          href={`${DOCS_DOMAIN}`}
          className={buttonVariants({ variant: "outline" })}
          target="_blank"
        >
          Explore the SDK
        </Link>
        <Button asChild variant="link" className="hidden sm:inline-flex">
          <Link
            href="https://github.com/jhonsfran1165/unprice"
            className="text-background-textContrast"
            target="_blank"
          >
            <span className="mr-1 flex size-6 items-center justify-center rounded-full transition-all">
              <GitHub aria-hidden="true" className="size-5 shrink-0 text-background-textContrast" />
            </span>
            <span>Star on GitHub</span>
          </Link>
        </Button>
      </m.div>
      <m.div
        className="relative mx-auto mt-8 grid w-full gap-4 sm:mt-14 lg:grid-cols-[minmax(0,1fr)_20rem]"
        variants={heroImageVariants}
      >
        <div className="rounded-lg border border-background-border bg-background-bgSubtle p-4 text-left shadow-sm">
          <MoneyPath />
        </div>

        <aside className="flex flex-col gap-3 rounded-lg border border-background-border bg-background-base p-4 text-left">
          <div>
            <p className="font-mono text-background-text text-xs uppercase tracking-widest">
              Trust sequence
            </p>
            <h2 className="mt-2 font-semibold text-background-textContrast text-lg">
              Nothing blocks traffic until the evidence convinces you.
            </h2>
          </div>
          <div className="flex flex-col gap-3">
            {trustChecks.map((check) => (
              <div
                key={check.label}
                className="flex items-center justify-between gap-4 rounded-md border border-background-border bg-background-bgSubtle px-3 py-2"
              >
                <span className="text-background-text text-sm">{check.label}</span>
                <span className="font-mono text-background-textContrast text-xs">
                  {check.value}
                </span>
              </div>
            ))}
          </div>
          <p className="text-background-text text-sm leading-6">
            Start on the built-in Sandbox. When you go live, connect your own Stripe account;
            Unprice never sits in your funds flow.
          </p>
        </aside>
      </m.div>
    </m.section>
  )
}
