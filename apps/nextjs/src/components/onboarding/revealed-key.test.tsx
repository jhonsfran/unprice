import { TooltipProvider } from "@unprice/ui/tooltip"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BUDGET_TERMS, TermList } from "~/components/budgets/budget-terms"
import { budgetsTwoCalls } from "~/components/landing/budgets-snippets"
import { RevealedKey } from "./revealed-key"

const KEY = "unprice_live_0123456789abcdef"

describe("Budgets setup key step", () => {
  it("shows the new runtime key in its own box with a copy button and a shown-once warning", () => {
    const html = renderToString(<RevealedKey apiKey={KEY} onContinue={() => {}} />).replace(
      /<!-- -->/g,
      ""
    )

    expect(html).toContain('aria-label="Your new runtime key"')
    expect(html).toMatch(new RegExp(`data-testid="revealed-runtime-key"[^>]*>${KEY}<`))
    expect(html).toContain('aria-label="Copy runtime key"')
    expect(html).toContain("Shown once")
  })

  it("copies the snippet with the real key while the screen shows it masked", () => {
    expect(budgetsTwoCalls(KEY)).toContain(`token: "${KEY}"`)
    expect(budgetsTwoCalls("unprice_live_••••")).not.toContain(KEY)
  })

  it("defines the Budgets terms in one line each", () => {
    const html = renderToString(
      <TooltipProvider>
        <TermList terms={["runtime key", "config key", "budget key"]} />
      </TooltipProvider>
    )

    for (const term of ["runtime key", "config key", "budget key"] as const) {
      expect(html).toContain(term)
      expect(html).toContain(BUDGET_TERMS[term])
      expect(BUDGET_TERMS[term]).not.toContain("\n")
    }
  })
})
