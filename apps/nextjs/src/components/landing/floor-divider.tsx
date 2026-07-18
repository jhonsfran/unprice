import { Leader } from "./station"

// The horizon between the business floor above and the proof floor below.
// The two halves of the page serve the two brains of the same buyer
// (marketing-framework.md): founders read the gains, engineers read the
// receipts. The reviewer's requirement is that nobody can miss the register
// change — so the handoff is a labeled band, not a whitespace guess.

export function FloorDivider() {
  return (
    <div className="w-full border-background-border border-t bg-surface-panel">
      <div className="mx-auto w-full max-w-6xl px-6 py-6">
        <div className="flex items-baseline gap-3">
          <span className="whitespace-nowrap font-mono text-background-textContrast text-sm uppercase tracking-widest">
            For your engineers
          </span>
          <Leader className="hidden sm:block" />
          <span className="hidden whitespace-nowrap font-mono text-[11px] text-background-text sm:inline">
            the proof floor
          </span>
        </div>
        <p className="mt-2 max-w-2xl text-background-text text-sm leading-6">
          Everything below is the same story in receipts: the full money path, the integration, the
          adoption path, the hard questions.
        </p>
      </div>
    </div>
  )
}
