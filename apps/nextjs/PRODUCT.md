# Product

## Register

product

## Users

Unprice serves SaaS founders, engineers, and small revenue teams who need to launch, enforce, and iterate pricing without hardcoding revenue logic into their application. They work inside the dashboard to define plans, model feature access, inspect customer usage, manage API keys, and connect the API into production request paths.

Their context is operational and technical: they are configuring money-adjacent infrastructure, debugging real customer access, and checking real-time spend or gating decisions. The UI should help them move quickly while preserving trust, auditability, and clear recovery paths.

## Product Purpose

Unprice is open-source PriceOps infrastructure for SaaS. It decouples pricing models, usage meters, limits, entitlements, and billing provider integration from application code.

The dashboard and API work together: the dashboard makes pricing, plans, customers, subscriptions, usage, and billing state understandable; the API makes those decisions easy to integrate into application code. Success means a founder or engineer can support any pricing model, enforce real-time spend and access gates, and change packaging without shipping product-code changes.

## Brand Personality

Precise, open, fast.

The product should feel like trustworthy infrastructure: technical enough for developers, legible enough for founders, and transparent enough for revenue-critical workflows. It should favor exact language, direct state, and obvious next actions over decorative SaaS gloss.

## Anti-references

Avoid black-box billing-tool aesthetics, vague "growth platform" language, and dashboards that hide operational state behind glossy metrics. Avoid over-decorated cards, marketing-style hero treatment inside the app, and UI that makes pricing models feel simpler by removing the details engineers need to trust.

Do not make the API feel secondary to the dashboard. Developer experience is part of the product surface.

## Design Principles

1. Make revenue logic inspectable: show the state, source, and next action behind pricing, gating, usage, and billing decisions.
2. Keep the developer path short: API keys, SDK examples, event ingestion, entitlement checks, and failure recovery should be easy to find and hard to misread.
3. Design for real-time control: spend, usage, and access gates need current status, clear limits, and explicit handling when customers are blocked or near a threshold.
4. Support pricing-model flexibility without ambiguity: flat, package, tiered, usage-based, and hybrid models should share a coherent mental model.
5. Prefer calm density: this is operational infrastructure, so compact, consistent, token-driven UI is better than decorative emphasis.

## Accessibility & Inclusion

Target WCAG AA for contrast, focus visibility, keyboard navigation, and form labeling. Respect reduced motion. Do not rely on color alone for pricing, entitlement, success, warning, danger, or failure states.
