---
name: establishing-studio-design-clarity
description: Use at the START of any Agent Studio / harness UI change in sapiom-js (packages/harness, packages/harness-desktop, packages/agent-studio) — a new component or screen, a restyle, or a vague "make it better / redesign" request — before you implement. Establishes what you're building from (a design? clear intent?), searches for it, and asks only if you can't find it.
---

# Establishing Studio design clarity

## Overview

Before you change Agent Studio / harness UI, establish **what you're building from**. Same rule as
its authoring sibling: **search first; then — only if you can't find it — ask before you build.**
Never ask before searching; never invent a visual or product direction in a vacuum. This skill is
deliberately thin — it encodes where the Studio's design lives and the ask-default, not how to search.

The Studio's design source is **`@sapiom/design-system`**, resolved through the harness build seam
(the branded package when installed, else the committed `ds-neutral` token mirror — see
`web/vite.config.ts`). Its hygiene rule already exists: **harness `CLAUDE.md` #6 — never redefine a
design-system token; read values with `var()`.** A local snapshot of token values is drift the moment
the source moves.

## The intake — run it before you implement

**1. Classify the change:** design work (new/restyled surface, "make it better/redesign") → full · hotfix → light · experiment → lightest.

**2. Find what you're building from — search before you ask, in order:**

- **The ask** — the ticket/PR for a design link, screenshot, or named reference.
- **Existing patterns** — grep `packages/harness/web/src` (and `packages/harness-desktop/src/renderer`) for the same surface; a sibling component usually solved it. Match its anatomy.
- **The tokens** — the design-system seam: `@sapiom/design-system` or `packages/harness/web/src/styles/ds-neutral/tokens.css` (the committed mirror). Read via `var()`; do not redefine or re-snapshot values.

**3. Verdict — and the ask-rule:**

- **Found a clear design or an existing surface to match** → proceed; **conform per harness `CLAUDE.md` #6** (tokens via `var()`, no local redefinition). Surface only the one real judgment call, after.
- **Design work, and after searching no clear design or intent** → **stop and ask 1–2 targeted questions before building.** Not proceed-on-a-default-and-notify. If the ask is a genuinely *new, unspecified* design, capture it as a written design doc first (so it isn't consumed verbally). On an **unattended/automated run** (no human to answer), post the question on the ticket/PR and **stop** — asking is not permission to build; if something must ship, build the smallest precedent-anchored version and label it as needing design sign-off.
- **Hotfix or experiment with minor ambiguity** → proceed with a precedent-anchored default; flag what you assumed.

**4. Conform.** There is no separate design-hygiene skill in this repo — the **seam + `CLAUDE.md` #6 are the gate.** Read tokens via `var()`, reuse an existing component over a new one, and match an existing Studio surface.

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll pick a sensible default; they can redirect later." | On design work with no design, that's proceed-and-notify. A 2-line question beats a wrong build. |
| "I'll hardcode the colour/size to match." | That redefines/snapshots a token — the exact drift `CLAUDE.md` #6 and the seam exist to prevent. Read it via `var()`. |
| "There's no design, so I'll invent one." | Search `packages/harness/web/src` first. If it's genuinely new, ask — don't invent. |
| "Asking is slower." | Asking *before* searching is. Asking *after* an honest search, with options, saves the rebuild. |

## Red flags — STOP

- You're choosing a visual/product direction and no design or existing surface backs it → search, then ask.
- You wrote a literal colour/size/spacing instead of a design-system `var()` token.
- You asked before searching `packages/harness/web/src`.
- A new component whose anatomy matches no existing Studio surface.

## Sibling skill

**`establishing-authoring-clarity`** (this repo) — the same intake for template/agent **authoring**
(source: `examples/AUTHORING.md`; dispatches to `sapiom-agent-authoring`). Use it for authoring, this
one for Studio UI.
