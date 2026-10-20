import { Dialog } from "@unprice/ui/dialog"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { releaseHoldInput } from "./release-hold"
import { ReleaseHoldForm } from "./release-hold-dialog"

const hold = { id: "h_4812", amount: "5", idempotencyKey: "job-991", createdAt: 1_796_083_140_000 }

function render(reason: string, attested: boolean, problem: string | null = null): string {
  return renderToString(
    <Dialog>
      <ReleaseHoldForm
        hold={hold}
        unit="money:USD"
        reason={reason}
        attested={attested}
        problem={problem}
        pending={false}
        onReasonChange={() => {}}
        onAttestedChange={() => {}}
        onSubmit={() => {}}
      />
    </Dialog>
  ).replace(/<!-- -->/g, "")
}

/** Whether the Release button renders disabled. */
function releaseDisabled(html: string): boolean {
  const button = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]
  if (!button) throw new Error("no Release button")
  return /\sdisabled=""/.test(button)
}

describe("ReleaseHoldForm", () => {
  it("keeps Release disabled until the reason has 10 characters and the box is checked", () => {
    const reason = "worker crashed pre-call"

    expect([
      releaseDisabled(render("", false)),
      releaseDisabled(render(reason, false)),
      releaseDisabled(render("too short", true)),
      releaseDisabled(render(reason, true)),
    ]).toEqual([true, true, true, false])
  })

  it("shows the hold, its amount, its idempotency key, the counter, and the server's answer", () => {
    const html = render("worker crashed", true, "h_4812 already closed.")

    expect(
      [
        "h_4812",
        "5.00 USD",
        "job-991",
        "14/500",
        "This work stopped and used nothing",
        "h_4812 already closed.",
      ].filter((text) => !html.includes(text))
    ).toEqual([])
  })
})

describe("releaseHoldInput", () => {
  it("names the hold by its id and creation time and trims the reason", () => {
    expect(releaseHoldInput("bgt_1", hold, "  worker crashed pre-call ")).toEqual({
      id: "bgt_1",
      holdId: "h_4812",
      holdCreatedAt: 1_796_083_140_000,
      reason: "worker crashed pre-call",
      confirm: true,
    })
  })
})
