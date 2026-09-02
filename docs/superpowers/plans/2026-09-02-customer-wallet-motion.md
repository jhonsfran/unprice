# Customer Wallet Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a five-second Figma Motion loop that explains one customer wallet credit flow.

**Architecture:** Create one top-level 16:9 frame in the active Figma Design file. Keep the information in static child layers, then apply manual keyframe tracks to the balance values, status labels, and one credit token. Do not change application code.

**Tech Stack:** Figma Design, Figma Motion timeline, Figma Plugin API

---

### Task 1: Inspect the active Figma file

**Files:**
- Inspect: active Figma Design file

- [ ] **Step 1: Read the active page structure**

Use the Figma plugin to return the editor type, page name, top-level frame names, node IDs, and canvas bounds.

- [ ] **Step 2: Confirm Motion access**

Read `figma.motion.figmaAnimationStyles()` and stop if the Motion API returns a `metronome` feature error.

### Task 2: Build the wallet frame

**Files:**
- Create: `Customer wallet flow · Motion test` in the active Figma Design file

- [ ] **Step 1: Create the top-level frame**

Create a 1280 by 720 frame to the right of existing top-level nodes. Use a dark neutral background and a 12 px corner radius.

- [ ] **Step 2: Create the information hierarchy**

Add a `Customer wallet` title, a `$10.00` available balance, and compact rows for `Granted`, `Held`, and `Consumed`. Add one small credit token and one event label.

- [ ] **Step 3: Verify the static frame**

Capture a screenshot. Check that every label is readable, the values align, and no layer overlaps another layer.

### Task 3: Add the Motion timeline

**Files:**
- Modify: `Customer wallet flow · Motion test` in the active Figma Design file

- [ ] **Step 1: Set the timeline duration**

Set the top-level frame timeline to 5 seconds.

- [ ] **Step 2: Animate the credit flow**

Animate the token with translation and opacity. Animate separate text layers for the available balance and event state so each value crossfades at the correct point. Use 200 to 300 ms ease-out transitions and holds between events.

- [ ] **Step 3: Check the resolved keyframes**

Read the frame timeline and each animated node's resolved animations. Confirm that grant, reserve, settle, and release occur in order and finish before 5 seconds.

- [ ] **Step 4: Export one review video**

Export the top-level frame as a low-frame-rate video at 768 px width. Review representative frames for the starting state, reserve state, settle state, and final hold.

- [ ] **Step 5: Return the Figma node**

Select the top-level frame and return its node ID, file link, duration, and export status.
