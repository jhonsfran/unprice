// The one place the demo recording is configured.
//
// It lives in its own module because two components depend on it: the demo
// station renders the player, and the hero derives its secondary CTA from it.
// Until the file exists, the hero must not offer to play a recording — three
// separate readers clicked "Watch it deny a request", landed on "not yet
// published", and read the whole page as a beautiful shell after that. An
// unmade artifact advertised in the hero costs more than no artifact.
//
// TO SHIP IT: set DEMO_VIDEO below. Nothing else changes — the station swaps
// its placeholder for the player and the hero CTA becomes the watch link.
// `captions` is required by the type on purpose: a recording without a caption
// track is not finished.

export type DemoVideo = {
  src: string
  captions: string
  poster?: string
}

export const DEMO_VIDEO: DemoVideo | null = null

export const hasDemoVideo = DEMO_VIDEO !== null
