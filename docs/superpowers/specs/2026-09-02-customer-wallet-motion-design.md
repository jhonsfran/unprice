# Customer wallet motion test

## Goal

Create a short Figma Motion test that explains how customer wallet credits move through one usage event.

## Format

- One 16:9 Figma Design frame.
- Five-second loop.
- Dark Unprice dashboard styling with restrained color.
- No application code changes.

## Story

1. A `$10.00 granted` credit enters the wallet.
2. Usage reserves `$4.10`. Available funds change from `$10.00` to `$5.90`.
3. Usage settles at `$3.20`. The wallet releases `$0.90`, and available funds become `$6.80`.

## Visual structure

The frame contains a customer wallet header, an available balance, and three compact rows for granted, held, and consumed funds. One small credit token moves between the rows. Text and balance changes carry the meaning, so color is only a secondary state cue.

## Motion

- Use position, opacity, and number changes only.
- Use 200 to 300 ms ease-out transitions.
- Add short holds after each state change.
- Do not use bounce, elastic motion, or decorative page-load effects.
- End on a short hold before the loop restarts.

## Acceptance criteria

- A viewer can name the grant, reserve, settle, and release events after one loop.
- All labels and values remain readable at 16:9 preview size.
- The animation uses Figma Motion keyframes and can be inspected on its timeline.
- The final frame can export as MP4 or WebM for review.
