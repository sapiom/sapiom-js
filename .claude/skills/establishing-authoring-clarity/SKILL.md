---
name: establishing-authoring-clarity
description: Use at the START of authoring a Sapiom template or agent in sapiom-js — a new template, a change to an existing one, or a vague "build an agent that does X" ask — before you write code. Establishes what you're building from (a spec? a sibling template? a clear outcome, user, and copy?), searches for it, and asks only if you can't find it. Then dispatches to sapiom-agent-authoring for the build.
---

# Establishing authoring clarity

## Overview

Before you author a Sapiom template or agent, establish **what you're building from**. Same rule
as its sibling intake, `establishing-studio-design-clarity`: **search first; then — only if you
can't find it — ask before you build.** Never ask before searching; never invent the product in a
vacuum.

The authoring-specific trap: a published template is judged by *the person deciding whether to use
it* (`examples/AUTHORING.md`) — so the **outcome, the target user, and the copy are the substance,
and the copy is "most of the work."** Writing the `index.ts` before those are clear produces a
runnable agent nobody can evaluate, with placeholder copy you'll rewrite. This skill is deliberately
thin — it does not re-teach the SDK; it encodes where the authoring sources live, the classification,
the ask-default, and the dispatch.

## The intake — run it before you author

**1. Classify the work:**

| Class | What it is | Rigor |
|---|---|---|
| **New published template** | a new directory under `examples/`, in the gallery | full — spec + copy |
| **Change to an existing template** | edit/fix to a shipped one | light |
| **Personal / experiment agent** | not published to the gallery | lightest — just label it |

**2. Find what you're building from — search before you ask, in order, stop when you have it:**

- **The ask itself** — the ticket/issue for a spec, or a named reference agent to model.
- **Sibling templates** — `examples/` almost always has one that solved a similar job. `AUTHORING.md`: *"look at an existing one — `examples/hello-agent` is the smallest — and copy its shape."* Match a sibling's `defineAgent`/`defineStep` graph and `template.json` shape rather than inventing structure.
- **The authoring guide** — `examples/AUTHORING.md`: the manifest fields, the **"runnable with nothing"** bar (§1a — `{}` in, a real run out), categorization (`category` / `discipline` / `cadence` / `complexity` / step `kind`), and the voice/copy rules.
- **The gate** — `pnpm examples:check` (house-style limits; run it, don't guess them).

**3. Verdict — and the ask-rule:**

- **Clear outcome + target user + copy, or a sibling to model** → you have clarity. Proceed; author via **`sapiom-agent-authoring`**; conform to `AUTHORING.md`.
- **New published template, and after searching the outcome / user / copy still isn't clear** → **stop and ask 1–2 targeted questions before building.** Don't invent what the agent is for — the copy is the deliverable, not a detail.
- **Experiment or a fix with minor ambiguity** → proceed with a sibling-anchored default; flag what you assumed.

**4. Author** → hand off to **`sapiom-agent-authoring`** (scaffold, test with `{}`, deploy) and conform to `AUTHORING.md` through submit.

## What a good question looks like

Ask **after** searching, name the sibling/guide, and put the real fork to them:

- ✅ "Closest existing template is `scheduled-research-brief` — same shape (scheduled, one output). Does this need pauses/approvals like `approval-chain`, or is it a straight run? And who's the target user — that drives the copy and the category."
- ✅ "There's no spec and no sibling for 'reconcile invoices.' What's the concrete input it runs on, and what's the one output a user reads?"
- ❌ "What should the agent do?" — no search, no options.
- ❌ *[ships a runnable agent with placeholder `template.json` copy]* — built before the substance was clear.

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll build a runnable version and write the copy after." | The copy *is* the work (`AUTHORING.md`). A runnable agent with invented copy is a template nobody can evaluate — you'll rewrite it. |
| "Asking is slower." | Asking *before* searching is. Asking *after* checking siblings + the guide, with options, saves the rewrite. |
| "No sibling exists, so I'll design the agent myself." | Search `examples/` and `AUTHORING.md` first. If it's genuinely new *and* published, the outcome/user is a product call — ask, don't invent. |
| "It's just a tweak to an existing template." | Then it's a change (light) — classify it and proceed. The ask-rule is for new published templates. |

## Red flags — STOP

- You're deciding what the agent is *for* / who it's *for* / what its copy says, and no ticket, sibling, or `AUTHORING.md` guidance backs it → search, then ask.
- You wrote `index.ts` for a published template before the outcome and copy were clear.
- You asked before searching `examples/` and `AUTHORING.md`.
- A new template whose shape doesn't match any sibling and skips `AUTHORING.md` → dispatch to `sapiom-agent-authoring` and conform.

## Sibling skill

**`establishing-studio-design-clarity`** (this repo) — the same intake for **Agent Studio / harness
UI** work (source: the `@sapiom/design-system` seam). Use it for UI, this one for template/agent
authoring.
