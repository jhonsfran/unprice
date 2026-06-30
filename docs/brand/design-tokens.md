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
  steps "meter usage / budget the request / explain the invoice."
