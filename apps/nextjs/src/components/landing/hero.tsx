"use client"

import { APP_DOMAIN } from "@unprice/config"
import { Button, buttonVariants } from "@unprice/ui/button"
import { ChevronRight, GitHub } from "@unprice/ui/icons"
import { m } from "framer-motion"
import { useTheme } from "next-themes"
import Link from "next/link"
import Balancer from "react-wrap-balancer"
import { useMounted } from "~/hooks/use-mounted"
import { HeroVideoDialog } from "./hero-video"
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

export default function Hero() {
  const { theme } = useTheme()
  const isMounted = useMounted()

  return (
    <m.section
      aria-labelledby="hero-title"
      className="mt-20 flex min-h-screen flex-col items-center justify-center text-center"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <m.h1
        id="hero-title"
        className="inline-block bg-clip-text p-2 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-7xl"
        variants={itemVariants}
      >
        <Balancer>
          Your product is smart,
          <br /> but your pricing is{" "}
          {isMounted && (
            <WordRotate
              className="italic"
              words={["hardcoded", "brittle", "static", "manual"]}
              shadowColor={theme === "dark" ? "white" : "black"}
            />
          )}
        </Balancer>
      </m.h1>
      <m.p
        className="mx-auto mt-6 max-w-2xl px-6 text-background-text text-lg"
        variants={itemVariants}
      >
        <br />
        <br />
        <b>The PriceOps Infrastructure for SaaS.</b> Decouple your pricing logic from your codebase.
        By treating pricing as infrastructure, you eliminate the engineering bottleneck preventing
        revenue growth.
        <br />
        <br />
        Test pricing models in minutes, not months. Ship usage-based, tiered, or hybrid models with
        a single integration. As you deploy Unprice, you’ll notice how quickly "billing tickets"
        disappear from your backlog.
        <br />
        <br />
        <span className="text-sm italic opacity-70">
          We integrate with billing engines like Stripe and Paddle. Unprice makes them
          swappable—change providers without touching code.
        </span>
      </m.p>
      <m.div
        className="my-14 flex w-full flex-col justify-center gap-3 px-6 align-middle sm:flex-row"
        variants={itemVariants}
      >
        <Link href={`${APP_DOMAIN}`} className={buttonVariants({ variant: "primary" })}>
          Start pricing
          <ChevronRight className="ml-1 h-4 w-4" />
        </Link>
        <Button asChild variant="link">
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
        className="relative mx-auto my-20 h-fit w-full max-w-6xl px-6"
        variants={heroImageVariants}
      >
        <div className="relative">
          <HeroVideoDialog
            className="block dark:hidden"
            animationStyle="from-center"
            videoSrc="https://www.youtube.com/embed/vAirXo6FJDs"
            thumbnailSrc="/unprice-light.png"
            thumbnailAlt="Hero Video"
          />
          <HeroVideoDialog
            className="hidden dark:block"
            animationStyle="from-center"
            videoSrc="https://www.youtube.com/embed/vAirXo6FJDs"
            thumbnailSrc="/unprice-dark.png"
            thumbnailAlt="Hero Video"
          />
        </div>

        <div
          className="-bottom-20 -mx-10 absolute inset-x-0 h-2/4 bg-gradient-to-t from-background-base via-background-base to-transparent lg:h-1/4"
          aria-hidden="true"
        />
      </m.div>
    </m.section>
  )
}
