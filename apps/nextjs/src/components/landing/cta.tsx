import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import Balancer from "react-wrap-balancer"

// The close is Sage, not Ruler: the hero promised control, the close promises
// understanding. The bracket corners are the logo's containment motif around
// the one decision left on the page — the reader's.

export default function Cta() {
  return (
    <section aria-labelledby="cta-title" className="w-full border-background-border border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 py-24 text-center sm:py-32">
        <h2
          id="cta-title"
          className="max-w-3xl font-primary font-semibold text-3xl text-background-textContrast tracking-tight sm:text-4xl"
        >
          <Balancer>
            Every allow, deny, charge, and credit — explained from one money path.
          </Balancer>
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <Balancer>
            Pick one paid action, run Unprice beside your current logic in shadow, prove the path on
            Sandbox, then enforce only when the evidence convinces you. The core is open source and
            your payments settle to your own Stripe account.
          </Balancer>
        </p>

        <div className="relative mt-10 px-6 py-5">
          <span
            aria-hidden
            className="absolute top-0 left-0 size-3 border-background-textContrast border-t-2 border-l-2"
          />
          <span
            aria-hidden
            className="absolute top-0 right-0 size-3 border-background-textContrast border-t-2 border-r-2"
          />
          <span
            aria-hidden
            className="absolute bottom-0 left-0 size-3 border-background-textContrast border-b-2 border-l-2"
          />
          <span
            aria-hidden
            className="absolute right-0 bottom-0 size-3 border-background-textContrast border-r-2 border-b-2"
          />
          <Link
            href={`${APP_DOMAIN}`}
            className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
          >
            Start with one paid action
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>

        <p className="mt-5 text-background-text text-sm">
          Not sure where to start?{" "}
          <a
            href="mailto:seb@unprice.dev"
            className="font-medium text-background-textContrast underline decoration-background-borderHover underline-offset-4 hover:decoration-background-textContrast"
          >
            Map my paid action
          </a>
        </p>
      </div>
    </section>
  )
}
