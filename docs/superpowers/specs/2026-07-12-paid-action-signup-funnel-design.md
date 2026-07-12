# Paid-Action Signup Funnel Repair Design

## Goal

Make the landing-page promise flow naturally into account creation while preserving attribution
and intent through authentication. This pass stops at funnel repair; it does not require a user to
make an external API request before onboarding completes.

## Customer flow

```text
Landing CTA -> Create account -> Workspace/onboarding -> First onboarding step
                    |                    |
                    +-- session/intent --+
```

## Changes

### 1. Send acquisition CTAs to signup

Primary acquisition CTAs on the landing experience should link directly to the app signup route,
not the app root that redirects new visitors to "Welcome back." Existing sign-in entry points stay
available for returning users.

Use one shared signup URL source so hero, closing CTA, header, and manifesto-style acquisition CTAs
do not drift.

### 2. Preserve attribution and destination

The auth pages already accept `sessionId` and `next`, and the marketing-cookie component creates or
restores a conversion ID. Keep both values when switching between signup and sign-in and pass the
destination through each supported authentication method.

Only allow safe in-app destinations for `next`; an external URL must not become an open redirect.
When no destination is supplied, preserve the current post-auth default.

### 3. Add public legal destinations

Terms and privacy links must resolve to public pages without entering the app-host authentication
redirect loop. Provide stable public URLs and point both signup and sign-in copy at them.

The legal pages can be concise placeholders based on existing product/company facts, clearly
marked for legal review. They must not invent guarantees or compliance claims.

### 4. Measure the repaired funnel

Preserve the existing conversion/session ID through signup and workspace creation. Add or reuse
events at meaningful boundaries:

- acquisition CTA selected;
- signup page reached;
- onboarding/workspace flow started.

Use the existing analytics mechanism and naming conventions. Do not create a second analytics
pipeline. Avoid collecting secrets or unnecessary personal data.

## Non-goals

- Requiring a real external API call to finish onboarding.
- Exposing an API secret in onboarding.
- Polling alignment or analytics-latency architecture.
- A visual redesign of the landing or auth pages.

## Verification

- Link/route tests cover the public CTA and legal destinations.
- Auth tests cover preservation of `sessionId` and a safe `next` value across signup/sign-in links.
- Focused Next.js tests, typecheck, and React diagnostics pass.
- Manually verify the landing-to-signup path and both legal links at desktop and mobile widths.

