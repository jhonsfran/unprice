# Responsive form dialogs

## Problem

The dashboard uses centered dialogs for many create and edit forms. These dialogs work on desktop,
but long forms can exceed the usable mobile viewport. Some call sites use `100vh`, fixed pixel
heights, or independent overflow rules. The mobile keyboard makes these constraints less reliable.

Mobile form layouts also use inconsistent breakpoints. Most field groups start as one column, but
some become two columns at the `sm` breakpoint while the overlay still has phone-sized space.

## Approaches considered

### Shared responsive compound component

Add one component that renders a Radix dialog at `md` and above and a Vaul bottom drawer below
`md`. Its trigger, content, header, title, description, footer, and close components select the
matching implementation through shared context.

This gives mobile users the expected bottom-drawer interaction and keeps form call sites
consistent. It requires a controlled migration because dialog and drawer components use different
React contexts.

### Restyle every dialog on mobile

Keep Radix Dialog for all viewports and make `DialogContent` look like a bottom drawer through CSS.
This preserves one component tree and needs fewer call-site changes. It would also change short
confirmation dialogs, and it would not provide Vaul drawer behavior such as touch dragging.

### Select dialog or drawer in each feature

Let each form call `useMediaQuery` and render its own dialog or drawer. This gives each feature full
control, but it duplicates breakpoint, spacing, scrolling, and accessibility logic across the app.

## Decision

Use the shared responsive compound component. Migrate create, edit, and configuration forms. Keep
destructive confirmations, alert dialogs, command dialogs, and short acknowledgements as centered
dialogs.

The responsive breakpoint is `md`, 768 pixels. Below that width, the component renders a bottom
drawer. At and above that width, it renders the existing centered dialog. This breakpoint gives
long forms enough room before they return to multi-column layouts.

## Component contract

Add `@unprice/ui/responsive-dialog` with these exports:

- `ResponsiveDialog`
- `ResponsiveDialogTrigger`
- `ResponsiveDialogContent`
- `ResponsiveDialogHeader`
- `ResponsiveDialogTitle`
- `ResponsiveDialogDescription`
- `ResponsiveDialogFooter`
- `ResponsiveDialogClose`

The API follows the current dialog component names so migration remains mechanical. The root owns
the viewport decision. All descendants read that decision from context and render only the Radix
or Vaul component that belongs to the active root.

The server snapshot uses the desktop dialog. Most overlays start closed, so hydration can update
the presentation before content becomes visible. Controlled overlays that start open may use the
desktop presentation for their first render. The current form dialogs do not start open.

## Mobile layout and scrolling

The drawer content will:

- use the full available width;
- cap its height against `100dvh`, not `100vh`;
- scroll vertically inside the drawer;
- contain overscroll so the page behind it does not move;
- include bottom safe-area padding for phones with a home indicator;
- keep a visible title for accessibility;
- use left-aligned form headings and actions.

The migration will remove fixed overlay heights such as `h-[800px]` and local `max-h-screen`
rules. A form owns its fields and submission state. The responsive overlay owns viewport sizing
and scrolling.

Form field groups must have one column below `md`. Two-column field layouts may start at `md`.
Option grids such as pricing-model choices can keep multiple columns when each option remains
usable at 320 pixels. This rule applies to field layout, not every grid inside a form.

## Scope

Migrate dashboard dialogs that contain create, edit, or configuration forms, including project,
domain, page, plan, plan-version, feature, event, customer, API-key, and member forms. Also migrate
form dialogs opened from cards and table row actions.

Do not migrate delete dialogs, ownership-transfer confirmations, `AlertDialog`, command palettes,
or existing detail sheets. Do not change form schemas, submit behavior, mutations, or business
rules.

## Accessibility and interaction

Every responsive overlay must render a title. Existing visible titles remain visible. Focus trap,
Escape handling, outside-click behavior, and focus return come from Radix Dialog or Vaul Drawer.
The trigger and close components must use the primitive that matches the active root.

Closing the overlay through a successful form submission must continue to call the existing
`onOpenChange` or local state setter. The migration must not create a second form tree or duplicate
form IDs.

## Verification

- Typecheck `@unprice/ui` and the Next.js app.
- Run focused tests for changed form components when tests exist.
- Run `pnpm validate`.
- Run React Doctor against changed React files and confirm that its score does not regress.
- Inspect representative short and long forms at 320, 390, 768, and desktop widths.
- Confirm that a long form scrolls while its page remains fixed.
- Confirm that fields stay in one column below 768 pixels.
- Confirm that the mobile keyboard does not hide the final form controls or submit action.
- Confirm that desktop forms still open as centered dialogs.
- Confirm that destructive confirmations remain centered dialogs.
