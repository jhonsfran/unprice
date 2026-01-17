"use client"

import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { ChevronRight } from "@unprice/ui/icons"
import { motion } from "framer-motion"
import { Link } from "next-view-transitions"
import Balancer from "react-wrap-balancer"

export default function Cta() {
  return (
    <section aria-labelledby="cta-title" className="mx-auto mt-32 max-w-6xl p-1 px-2">
      <div className="relative flex items-center justify-center">
        <motion.div
          className="max-w-4xl"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="flex flex-col items-center justify-center text-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.6 }}
            >
              <h3
                id="cta-title"
                className="inline-block bg-clip-text p-2 font-bold text-4xl text-background-textContrast tracking-tighter md:text-6xl"
              >
                Unprice, the PriceOps Infrastructure.
              </h3>
              <p className="mx-auto mt-4 max-w-2xl text-background-text text-lg">
                <Balancer>
                  We are on early stage, but we are working hard to make it better. Let us know if
                  you have any feedback.
                </Balancer>
              </p>
            </motion.div>
            <motion.div
              className="mt-10 w-full p-1.5"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.6 }}
            >
              <Link href={`${APP_DOMAIN}`} className={buttonVariants({ variant: "primary" })}>
                Start pricing
                <ChevronRight className="ml-1 h-4 w-4" />
              </Link>
            </motion.div>
            <motion.p
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
                Talk to me
              </a>
            </motion.p>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
