"use client"

import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { ChevronRight } from "@unprice/ui/icons"
import { m } from "framer-motion"
import { Link } from "next-view-transitions"
import Balancer from "react-wrap-balancer"

export default function Cta() {
  return (
    <section aria-labelledby="cta-title" className="mx-auto mt-24 w-full max-w-6xl px-6 py-16">
      <div className="relative flex items-center justify-center">
        <m.div
          className="max-w-4xl"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="flex flex-col items-center justify-center text-center">
            <m.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.6 }}
            >
              <h3
                id="cta-title"
                className="inline-block bg-clip-text p-2 font-bold text-4xl text-background-textContrast tracking-tighter md:text-6xl"
              >
                Authorize customer spend before paid work runs.
              </h3>
              <p className="mx-auto mt-4 max-w-2xl text-background-text text-lg">
                <Balancer>
                  Pick one paid action, run Unprice beside your current logic in shadow, prove the
                  path on Sandbox, then enforce only when the evidence convinces you. The core is
                  open source and your payments settle to your own Stripe account.
                </Balancer>
              </p>
            </m.div>
            <m.div
              className="mt-10 w-full p-1.5"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.6 }}
            >
              <Link href={`${APP_DOMAIN}`} className={buttonVariants({ variant: "primary" })}>
                Start with one paid action
                <ChevronRight data-icon="inline-end" />
              </Link>
            </m.div>
            <m.p
              className="mt-4 text-background-text text-xs sm:text-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6, duration: 0.6 }}
            >
              Not sure where to start?{" "}
              <a
                href="mailto:seb@unprice.dev"
                className="font-semibold text-primary-textContrast hover:text-primary-textContrast/80"
              >
                Map my paid action
              </a>
            </m.p>
          </div>
        </m.div>
      </div>
    </section>
  )
}
