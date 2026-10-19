// The launch video, beside the hero headline: the page restates what the video promises, and a
// reader who skipped it can watch it there. It never autoplays, because the narration carries
// it. The music credit is in the video's own end card.

const VIDEO = {
  src: "/videos/budgets-launch.mp4",
  poster: "/videos/budgets-launch.jpg",
}

export function BudgetsVideo() {
  return (
    <div className="rounded-lg border border-background-border bg-surface-panel p-2 shadow-ambient sm:p-3">
      {/* biome-ignore lint/a11y/useMediaCaption: captions were dropped on purpose; the video's on-screen text carries the claims */}
      <video
        aria-label="Unprice Budgets launch video: an agent's overnight run, a hard cap per key, and a hundred agents against one cap"
        controls
        playsInline
        preload="none"
        poster={VIDEO.poster}
        src={VIDEO.src}
        className="aspect-video w-full rounded-sm bg-background-bg"
      />
    </div>
  )
}
