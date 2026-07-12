# Design Tokens

Date: 2026-06-30

This is the canonical color and logo token reference for Unprice. It is grounded in the live theme
engine at [`tooling/tailwind/generate-theme.ts`](/Users/jhonsfran/repos/unprice/tooling/tailwind/generate-theme.ts)
and the Radix color scales imported in
[`tooling/tailwind/themes`](/Users/jhonsfran/repos/unprice/tooling/tailwind/themes). When a value
here disagrees with the generated theme, the code wins — update this doc after verifying.

It complements [`design-system-guidelines.md`](design-system-guidelines.md) (how to use color) and
[`brand-identity.md`](brand-identity.md) (why the brand looks the way it does).

## Token Layers

Two layers, kept separate on purpose:

1. **Brand identity tokens** — theme-independent. The logo, favicon, and key brand moments. Fixed
   hex so assets render identically in email, OG cards, and any external surface.
2. **Product semantic tokens** — generated per theme by `generateTheme(themeName)`. Status, surface,
   and text roles that adapt to light/dark and to the active theme (`sunset` default, `slate` alt).

Do not pull product semantic colors into the logo, and do not hardcode brand hex inside product UI.

## Brand Identity Tokens

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `brand.ink` | `#0a0a0a` | `#fafafa` | Foreground. The bracket, wordmark, body ink. |
| `brand.paper` | `#fafafa` | `#0a0a0a` | Background the ink sits on. |
| `brand.signal` | `#ab6400` | `#ffc53d` | The accent. The value being gated. Amber, surface-aware: `amber-11` on light, `amber-9` (the platform `primary`) on dark. |

Notes:

- `brand.signal` is Radix amber. On dark surfaces it is `amber-9` (`#ffc53d`) — the same scale as the
  product `primary` token, so the logo accent matches every primary action. On light surfaces it steps
  to `amber-11` (`#ab6400`): `amber-9` on near-white is only ~1.4:1, while `amber-11` is ~4.9:1 (AA).
  Same hue, surface-aware step. Reference: `--amber-9` / `--amber-11` in
  [`@radix-ui/colors/amber`](/Users/jhonsfran/repos/unprice/node_modules/.pnpm/@radix-ui+colors@3.0.0/node_modules/@radix-ui/colors/amber.css).
- Amber is money-coded: it carries the brand's stakes (control over value). The request-path *mechanism*
  is told in copy and in the `info` (blue) status color, not in the brand hue.
- `brand.ink` / `brand.paper` are near-pure neutrals, not the theme grayscale (`sand-12` / `slate-12`).
  This is intentional: the mark needs maximum contrast at 16px favicon sizes and on arbitrary
  surfaces. They approximate `sand-12` (`#21201c` / `#eeeeec`) but stay pure.
- The light-surface logo dot uses this same `amber-11` (`#ab6400`). For legible amber *text* on a
  surface, use `amber-11` = `#ab6400` (light) / `#ffca16` (dark); reserve `amber-9` for solid accents
  on dark. "Calm" comes from the step, not the hue.

### Logo Color Spec

The mark is a pair of brackets cradling a single signal point. Source of truth:
[`internal/ui/src/unprice.tsx`](/Users/jhonsfran/repos/unprice/internal/ui/src/unprice.tsx).

| Element | Color | Rule |
| --- | --- | --- |
| Brackets | `brand.ink` | Always neutral. Never recolor. They are the calm infrastructure. |
| Action dot | `brand.signal` — `amber-9` (`#ffc53d`) on dark, `amber-11` (`#ab6400`) on light | The one element carrying color; the light step keeps AA contrast. `brand.ink` when `monochrome`. |
| Wordmark | `brand.ink` | `font-primary` (Geist), weight 600, letter-spacing -0.04em, lowercase. |
| Favicon tile | `brand.ink` (`#0a0a0a`), rx 8 of 32 | Brackets in `brand.paper`, dot in `amber-9` (`#ffc53d`) — the tile is always dark. |

Clear space: at least the icon's own width on all sides. Minimum icon size: 16px (use the tiled
favicon below that). The dot is the only place a decision color may appear — this mirrors the
product law "emphasis only when it changes a decision" (`design-system-guidelines.md`).

Loading state: `UnpriceSpinner` (same file) is the mark's loading form — the value bounces in its
cradle: apex just clear of the gate mouth (it cannot pass; the dot is wider than the opening),
contact kissing the base, one bounce per second. Fall accelerates (ease-in-quad), rise decelerates
on `ease-out-quad`. Rigid ball, no squash. The brackets never move and never recolor; amber stays
on the one element in motion, on its vertical axis. Under `prefers-reduced-motion` the dot rests
in the cradle and breathes opacity. Sizes 16/20/32/48 (`sm`–`xl`), honoring the 16px minimum.
`LoadingAnimation`'s default variant renders it in monochrome `theme="inherit"` (the whole mark
rides `currentColor`, like the lucide Loader it replaced), so every existing loading state is
branded and stays legible on any surface — amber primaries and destructive buttons included. The
amber value (`theme="inherit"` non-monochrome steps amber-11 → amber-9 with `.dark`) is reserved
for controlled surfaces where the background is known.

Static favicon assets that must match the component:
[`apps/nextjs/public/icon.svg`](/Users/jhonsfran/repos/unprice/apps/nextjs/public/icon.svg) and
[`apps/nextjs/src/app/icon.svg`](/Users/jhonsfran/repos/unprice/apps/nextjs/src/app/icon.svg).

## Product Semantic Tokens

`generateTheme` maps each semantic role to a Radix scale, then exposes Radix steps as named roles
via `generateVariantRadixColors`:

| Role token | Radix step | Use |
| --- | --- | --- |
| `DEFAULT` / `solid` | 9 | Solid fills, primary accents. |
| `solidHover` | 10 | Hover on solid. |
| `text` | 11 | Text on a neutral surface. |
| `textContrast` | 12 | High-emphasis text. |
| `base` … `bgActive` | 1–5 | Surfaces from page to pressed. |
| `line` / `border` / `borderHover` | 6 / 7 / 8 | Separators and borders. |
| `foreground` | `black`/`white` a12 | Text on the solid (9) fill. |

The grayscale is chosen from the primary: `grayScalePairs[theme.primary]`. Surfaces (`background`,
`card`, `popover`), `border`, `input`, `ring`, `muted`, and `foreground` all derive from it.

### Default theme — `sunset` (`defaultTheme` in `preset.ts`)

Grayscale: **sand**. Solid (step 9) values, identical in light and dark:

| Token | Scale | Solid `#9` | Foreground on solid |
| --- | --- | --- | --- |
| `primary` | amber | `#ffc53d` | black |
| `secondary` | bronze | `#a18072` | white |
| `success` | green | `#30a46c` | white |
| `warning` | orange | `#f76b15` | white |
| `danger` / `error` / `destructive` | tomato | `#e54d2e` | white |
| `info` | blue | `#0090ff` | white |

Sand grayscale anchors: `background` (`sand-2`) `#f9f9f8` / `#191918`; `foreground` (`sand-11`)
`#63635e` / `#b5b3ad`; `textContrast` (`sand-12`) `#21201c` / `#eeeeec`.

## Elevation & Material Tokens

Added 2026-07-08 (the "light the ledger" pass). Defined as CSS custom properties in
[`apps/nextjs/src/styles/globals.css`](/Users/jhonsfran/repos/unprice/apps/nextjs/src/styles/globals.css)
and duplicated in
[`apps/nextjs/src/styles/sites.css`](/Users/jhonsfran/repos/unprice/apps/nextjs/src/styles/sites.css);
exposed as Tailwind colors/shadows via `generate-theme.ts` and `preset.ts`.

### Surface tiers — page < panel < raised

The page is a desk; panels are receipts lying on it. The tiers invert differently per mode, which
is why they are custom properties and not raw Radix steps:

| Token | Tailwind | Light | Dark | Use |
| --- | --- | --- | --- | --- |
| `--surface-page` | `bg-surface-page` | `sand-2` `#f9f9f8` | `#0e0e0d` (below sand-1) | Marketing page ground, dashboard content well. |
| `--surface-panel` | `bg-surface-panel` | `sand-1` `#fdfdfc` | `sand-2` `#191918` | Cards, stage panels, receipts. |
| `--surface-raised` | `bg-surface-raised` | `#ffffff` | `sand-3` `#222221` | Artifacts on a panel (tickets, invoice lines). |

Rules:

- Outer stage surfaces (cards sitting on the page) use `surface-panel`. Inner wells inside a panel
  keep the Radix tint (`bgSubtle`/`bg`) — their borders carry them in dark.
- Trap: anything left on `bg-background-bgSubtle` while sitting directly on the page is invisible
  in light mode (both are `sand-2`). If a panel "disappears" in light, this is why.
- The dashboard sidebar/header chrome stays on `sand-1` (body); only the scrollable content well
  drops to `surface-page`, so chrome reads above ground.

### Shadows

| Token | Tailwind | Light | Dark |
| --- | --- | --- | --- |
| `--shadow-ambient` | `shadow-ambient` | tight contact shadow (blur ≤ 8px) | `inset 0 1px 0 white/4` — a lit top edge |
| `--shadow-raised` | `shadow-raised` | slightly deeper contact (blur ≤ 12px) | `inset 0 1px 0 white/6` |
| `--shadow-keycap` | `shadow-keycap` | inner top light + 1–4px drops | same, black drops |
| `--shadow-keycap-press` | `shadow-keycap-press` | reduced keycap | reduced keycap |

Laws:

- **Receipts lie flat.** Light-mode shadows are contact shadows, never floaty (no blur ≥ 16px).
- **Dark mode has no drop shadows.** Black-on-black is invisible; "lifted" in dark is a lighter
  surface plus a 1px lit top edge. Never port a light shadow to dark.
- `shadow-raised` is for signature panels (money path, pricing stage, system-map center);
  `shadow-ambient` for everything else. If everything is raised, nothing is.

### Hairlines, rails, ledger paper

- Dark-mode neutral borders are translucent white, not gray paint: `.dark` overrides
  `--sand-6/7/8` to `rgb(255 255 255 / .07 / .10 / .16)`. All `border-*`, `ring`, and `input`
  tokens inherit this automatically.
- `--rail` (`sand-4` light / `white/5` dark): the vertical hairlines framing the marketing content
  column (`SectionShell`), with `+` registration ticks where section rules cross them.
- `--ledger-dot`: the faint dot-grid paper texture (`.ledger-dots` utility — painted on `::before`
  with a masked fade so content is never masked). Same material as the OG image ground.

### Sync rule (important)

These tokens live in **two stylesheets that do not import each other**:
`globals.css` (the `(root)` tree: landing, dashboard) and `sites.css` (the `(sites)` tenant
product). Both also define `.button-primary`. Any change to the token block or the primary button
recipe must be made in both, or tenant sites silently diverge (unresolved vars render transparent).

Ops note: Tailwind does not watch `tooling/tailwind/preset.ts` through the workspace symlink —
after editing the preset or `generate-theme.ts`, restart the dev server (a `@apply` of a new token
errors until then). Custom-property overrides of Radix vars must be **unlayered** CSS placed after
the theme imports; anything inside `@layer base` loses to the unlayered Radix imports.

## Motion Tokens

Defined in `preset.ts` (2026-07-08). One vocabulary for every hover, entrance, and panel:

| Token | Value | Use |
| --- | --- | --- |
| `duration-quick` | 160ms | Hovers, presses, chips. |
| `duration-regular` | 260ms | Color/state changes, station lighting. |
| `duration-deliberate` | 400ms | Panels, reveals. |
| `ease-out-quad` | `cubic-bezier(.25,.46,.45,.94)` | Default for hovers. |
| `ease-out-cubic` | `cubic-bezier(.215,.61,.355,1)` | Entrances. |
| `ease-out-expo` | `cubic-bezier(.19,1,.22,1)` | Large panel movement. |

Do not hardcode `duration-300`/ad-hoc beziers in new components. The three sanctioned motion
systems are: the money path's WAAPI choreography, the station-header IntersectionObserver
lighting, and the `Reveal` entrance primitive
([`apps/nextjs/src/components/landing/reveal.tsx`](/Users/jhonsfran/repos/unprice/apps/nextjs/src/components/landing/reveal.tsx)).
Do not add a fourth.

## Display Type Scale

Marketing display sizes, defined in `preset.ts` `fontSize` (2026-07-08). Geist is a variable font;
each token carries size, line-height, tracking, **and weight**:

| Token | Size | Weight | Tracking | Use |
| --- | --- | --- | --- | --- |
| `text-display-1` | clamp 44→56px | 540 | −0.022em | Page hero (one per page). |
| `text-display-2` | clamp 36→48px | 550 | −0.02em | Closing statement. |
| `text-display-3` | clamp 28→36px | 560 | −0.018em | Section H2s. |

Laws:

- **Bigger means lighter, never heavier.** Display type is weight 540–560; `font-extrabold`
  display headings are banned (the pre-glow-up 40px/800 hero read as a subsection). Reference:
  Linear runs 64px at weight 510.
- Tracking floor is −0.025em; tighter and letters touch.
- Two-tone emphasis: the setup clause in `text-background-text` (muted), the operative clause in
  `textContrast` (ink). Emphasis by precision, not decoration. One split per headline, max.
- `display-1` caps at 3.5rem because the hero pairs with the money path in a ~28rem column; 4rem
  wraps to four cramped lines.
- Dashboards never use display sizes (see `design-system-guidelines.md`: headings proportional to
  their container).

## Status Semantics

These map the semantic tokens to the meanings in `design-system-guidelines.md`. Always pair color
with a text label or icon — never color alone.

| Meaning | Token | sunset | slate |
| --- | --- | --- | --- |
| Accepted / processed / paid / healthy | `success` | green | teal |
| Near-limit / pending / retryable | `warning` | orange | amber |
| Denied / rejected / failed / budget exceeded | `danger` | tomato | tomato |
| Live request path / developer action | `info` | blue | indigo |
| Inactive / archived / historical | `muted` | sand | slate |

The request path is told with `info` (blue in `sunset`, indigo in `slate`) and in copy — not in the
brand hue. `brand.signal` (amber) is the identity / `primary` accent for actions and key brand
moments; keep it distinct from status colors so a primary action never reads as a warning. This is
why `warning` is `orange` in `sunset`, not amber.

## Other Tokens

- Radius: `--radius` drives `borderRadius.lg/md/sm` (`preset.ts`). Keep operational cards at 8px or
  less per `design-system-guidelines.md`. The favicon tile uses 8 of 32 (25%).
- Type: `--font-primary`, `--font-secondary`, `--font-mono` (`preset.ts`). Wordmark uses `font-primary`
  (Geist) at 600 / -0.04em. Note `font-sans` is *not* mapped to Geist — it falls back to the system
  stack, so brand surfaces must use `font-primary`. Monospace is reserved for IDs, slugs, amounts, and
  ledger facts.

## Decision Log

### 2026-07-12 — Logo optics settled; branded spinner (the value runs the path)

Measured in a browser lab (screenshots at 16–96px, x-height probes against Geist), not eyeballed.

- **Dot seats in the cradle**: cy moves 15.1 → 15.6 in the mark's 20-unit space (favicons 15 →
  15.5). The old position left ~2× more air below the dot than above it, crowding the gate mouth;
  the new one keeps a deliberate 0.4-unit optical lift above the cavity's geometric center.
- **Lockup nudge**: flex-centering hung the icon ~0.02em high of the lowercase word's optical band
  (measured against a 1ex probe at 56px); the icon now translates down `0.02em` in the full lockup.
- **`UnpriceSpinner`**: loading is the brand's core moment — a decision in flight before paid work
  runs — so the spinner is the value alive inside the brackets, not a rotating arc. The amber dot
  bounces in the cradle (apex clear of the gate it cannot pass, contact on the base, 1s cycle,
  gravity fall / `ease-out-quad` rise, rigid ball); brackets stay ink and static per the logo
  color spec. Reduced motion swaps to the resting dot breathing opacity — so the pulse form exists
  too, as the no-motion fallback. Concepts rejected in the lab: orbit around the cavity (v1;
  review verdict: the value wandering the whole mark reads busy at button sizes — it stays on its
  vertical axis), stroke-sweep/draw-on (breaks the mark's silhouette mid-cycle and puts motion on
  the "calm infrastructure"), ring ping (invisible at 16px), trail ghosts (reads as multiple
  values; there is one value), pulse-as-primary (no positional motion — reads as a status light,
  not work in progress).

Grounded in a measured teardown of linear.app, dub.co, and useautumn.com (computed styles and
token dumps, not eyeballing). The verdict: the money-path concept was ahead of its execution —
the page had no surface tiers, no shadow tokens, a 40px/800 hero, and a primary CTA in the Radix
"soft" recipe that read as a secondary. All fixes were token-level, so the dashboard inherited
them.

- **`.button-primary` is now the solid signal**: `bg-primary-solid` (amber-9) + `text-primary-foreground`
  (black-a12, mode-independent) + `shadow-keycap` + 0.5px press, 160ms `ease-out-quad`. The old
  soft recipe (amber-2 wash, amber-11 text, amber border) visually demoted the main action.
- **One solid amber per viewport** — the page-scale version of "the dot is the only place a
  decision color may appear." When the hero owns the solid primary, the header CTA demotes to
  outline. Scarcity is the signal.
- Elevation, hairline, motion, and display-type tokens as documented above.
- **Typeface decision: Geist stays.** The audit proved the typeface was never the weakness — the
  same font at 56px/540 reads Linear-class (Linear itself uses Inter, differentiated purely by
  weight discipline). Known trade-off: Autumn ships the identical Geist + Geist Mono stack, so the
  typeface cannot differentiate; the ground (warm sand vs their black-purple), amber scarcity, and
  receipt grammar do. Optional future upgrade, to be made deliberately and doc-first: replace
  Geist Mono with a licensed characterful mono (e.g. Berkeley Mono) — the mono is where the brand
  voice lives (facts, indices, invoice lines), so it is the one font purchase with real ROI.

### 2026-06-30 — Brand signal stays amber; logo reworked from tile to brackets

- The brand signal is Radix `amber-9` (`#ffc53d`) — the same scale as the platform `primary`, so the
  logo accent matches every primary action. The mark moved from a solid amber *tile* + letter "u" to
  a pair of neutral ink brackets cradling a single amber dot.
- Why amber: (1) amber is the existing `primary` and is a real Radix scale (contrast, light/dark,
  and steps handled); a custom gold would have none of that. (2) Amber is money-coded, which matches
  the brand's stakes — control over value — and all current copy. The request-path *mechanism* is the
  differentiator and lives in copy and the `info` (blue) color, not the brand hue.
- Why the mark still reads "calm": loudness came from amber as a large *tile*, not from the hue.
  Demoting it to a small dot on neutral ink, and reserving `amber-9` for solid accents (surfaces use
  `amber-2/3`, text uses `amber-11`), keeps the system calm while staying amber.
- Status hygiene: `warning` is `orange` (as `sunset` already ships), not amber, so the brand/primary
  amber never collides with the "near-limit" status. Request-path guidance uses `blue` (`info`),
  which is in the `sunset` palette.
- The previous logo hardcoded `#f5b62b`, which was not even the theme's `amber-9` (`#ffc53d`). The
  signal is now the real `primary` token value rather than a one-off hex.

### 2026-06-30 — Surface-aware signal dot + Geist wordmark

- The logo dot is now surface-aware: `amber-9` (`#ffc53d`) on dark, `amber-11` (`#ab6400`) on light.
  `amber-9` on near-white was only ~1.4:1 (effectively invisible); `amber-11` is ~4.9:1 (AA). Same
  amber hue, Radix step chosen for the surface — not a new brand color. The favicon tile is always
  dark, so it keeps `amber-9`.
- The wordmark now renders in `font-primary` (Geist), not `font-sans`. The preset maps only
  `font-primary` / `font-secondary` / `font-mono` to Geist; `font-sans` falls back to the system
  stack, so the old `font-sans` wordmark shipped in San Francisco/Segoe. Stray brand `font-sans`
  usages (`pricing-hero.tsx`, `version-context-strip.tsx`) moved to `font-primary`; the email
  `<Body>` usages stay `font-sans` (mail clients can't rely on Geist).

### Considered and rejected

- Custom gold (`#e3a82f` / `#c98a1e`): no Radix scale, no dark pair, no contrast guarantees — unfit
  for a color that drives the whole platform.
- Muted Radix warms (`gold-9 #978365`, `bronze-9 #a18072`): valid and calmer, but they lose amber's
  punch and would split the logo accent from `primary`.

### Open follow-ups

- [`internal/email/src/emails/invite.tsx`](/Users/jhonsfran/repos/unprice/internal/email/src/emails/invite.tsx):
  copy is now on-brand and the `#ffc53d` CTA reads as `primary` (black text on amber). The header
  logo is still a remote brand-kit PNG on CloudFront (the old amber mark); regenerate it as the
  bracket mark and re-host, since it cannot be tokenized from code.

Resolved 2026-06-30 (realigned to the tokens above):

- Favicons [`apps/nextjs/public/icon.svg`](/Users/jhonsfran/repos/unprice/apps/nextjs/public/icon.svg)
  and [`apps/nextjs/src/app/icon.svg`](/Users/jhonsfran/repos/unprice/apps/nextjs/src/app/icon.svg)
  now match the bracket-pair component exactly.
- [`apps/nextjs/src/app/(root)/og/route.tsx`](/Users/jhonsfran/repos/unprice/apps/nextjs/src/app/(root)/og/route.tsx):
  the `SimpleLogo` pillars became the bracket mark, the wordmark is now ink (`#fafafa`) not amber,
  and the emoji "track usage / iterate prices / real-time insights" chips became the money-path
  steps "authorize usage / preserve evidence / explain the invoice."
