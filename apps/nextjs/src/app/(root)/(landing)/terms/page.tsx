import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import type { Metadata } from "next"

const description =
  "Placeholder terms for Unprice, the open-source customer money-path software. Legal review pending."

export const metadata: Metadata = {
  title: "Terms of Service",
  description,
  alternates: {
    canonical: "https://unprice.dev/terms",
  },
}

export default function TermsPage() {
  return (
    <article aria-labelledby="terms-title" className="w-full">
      <div className="mx-auto w-full max-w-6xl border-[color:var(--rail)] px-6 py-20 sm:py-24 lg:border-x">
        <div className="max-w-3xl">
          <p className="font-mono text-background-text text-xs uppercase tracking-widest">Legal</p>
          <h1
            id="terms-title"
            className="mt-6 font-primary text-background-textContrast text-display-1"
          >
            Terms of Service
          </h1>
          <p className="mt-6 text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            These are concise placeholder terms for Unprice. They describe the product at a high
            level while the final terms are under review.
          </p>

          <Alert variant="warning" className="mt-10">
            <AlertTitle>Legal review pending</AlertTitle>
            <AlertDescription>
              This page is not final legal terms. It will be replaced after legal review.
            </AlertDescription>
          </Alert>

          <div className="mt-12 flex flex-col gap-10">
            <section aria-labelledby="terms-product">
              <h2 id="terms-product" className="font-primary text-2xl text-background-textContrast">
                The product
              </h2>
              <p className="mt-3 text-background-text leading-7">
                Unprice is open-source customer money-path software, available under the AGPL-3.0
                license. Its hosted cloud is in early access and free at present.
              </p>
            </section>

            <section aria-labelledby="terms-scope">
              <h2 id="terms-scope" className="font-primary text-2xl text-background-textContrast">
                Scope of this notice
              </h2>
              <p className="mt-3 text-background-text leading-7">
                This placeholder is a summary, not a complete agreement. It does not create or
                replace final legal terms, which will be published after review.
              </p>
            </section>
          </div>
        </div>
      </div>
    </article>
  )
}
