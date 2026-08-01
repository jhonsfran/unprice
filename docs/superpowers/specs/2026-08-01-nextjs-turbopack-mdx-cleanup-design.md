# Next.js Turbopack MDX Cleanup Design

## Problem

After upgrading the dashboard from Next.js 14.2.35 to 15.5.21, local development began
showing multi-second first-route compiles and one 277-second `/icon.svg` compile that blocked
unrelated requests. The server also warns that webpack is configured while Turbopack is active.

The dashboard does not contain or import any `.mdx` content. Its unused MDX setup still:

- installs `@next/mdx` 14.3.0-canary.44 beside Next.js 15.5.21;
- wraps `next.config.mjs` with a plugin that injects a webpack configuration;
- enables `experimental.mdxRs` and adds `mdx` to `pageExtensions`;
- keeps an orphaned `mdx-components.tsx`, `next-mdx-remote`, and `@types/mdx`.

Next.js 15 Turbopack does not execute webpack configuration. The stale MDX wrapper is therefore
an unsupported configuration boundary and the first variable to remove before diagnosing a
Turbopack engine defect.

## Decision

Keep Turbopack as the default development bundler and remove the unused MDX surface completely.

The change will:

1. Remove `@next/mdx`, `next-mdx-remote`, and `@types/mdx` from `apps/nextjs/package.json` and
   update the workspace lockfile through pnpm.
2. Remove the `@next/mdx` import and wrapper, the `mdx` page extension, and `experimental.mdxRs`
   from `apps/nextjs/next.config.mjs`.
3. Delete the now-unused `apps/nextjs/src/mdx-components.tsx` file.
4. Preserve the current Turbopack development scripts and all existing auth, middleware, route,
   and tRPC behavior.

## Verification

Static verification will include the Next.js package tests, typecheck, and build. Runtime
verification will run the Next.js development server with `NEXT_TURBOPACK_TRACING=1`, request
`/icon.svg` and representative dashboard routes, and compare cold and warm request timings.

Success means:

- the webpack/Turbopack configuration warning is gone;
- `/icon.svg` and representative routes compile without request starvation;
- focused tests, typecheck, and build pass;
- no `.mdx` dependency or configuration remains in `apps/nextjs`.

If the stall remains after the unsupported MDX configuration is removed, the generated
Turbopack trace becomes the evidence for the next minimal hypothesis: a Next.js 15.5 Turbopack
defect in metadata-route compilation. A Next.js patch upgrade or an upstream report will be
considered only from that trace; webpack remains a fallback, not the default design.

## Trade-offs

- The dashboard loses dormant MDX support. Restoring it later requires adding a Next-version-
  compatible MDX setup and real content together.
- Runtime verification requires starting a temporary local dev server. It will use an available
  port and will be stopped after measurements.
- Removing the unsupported integration narrows the compiler graph and removes a warning, but it
  does not by itself prove that Turbopack contains no independent metadata-route bug.
