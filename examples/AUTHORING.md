# Authoring Sapiom templates — copy & structure guide

This is the contract for how a Sapiom workflow template describes itself. It covers the
**copy** (the words a user reads in the gallery and on the template detail page) and how
that copy maps onto the two files that feed it. Follow it when you add a template or when
an agent generates one, so every template reads in one consistent voice.

If you only remember one thing: **write for the person deciding whether to use this, not
for the person who built it.** Plain, concrete, second-person. No pitch.

---

## Where the copy lives

Two files per template feed the UI. Keep them consistent — the same template, described
the same way, at two levels of depth.

### `examples/registry.json` — the gallery index (one entry per template)

| Field | Shows up as | Write it as |
|---|---|---|
| `name` | Card title, detail H1 | Title Case, human. "Human-in-the-Loop Approval", not the slug. |
| `description` | Card subtitle, detail subtitle | **One sentence.** What it does, in plain words. See "The tagline" below. |
| `tags` | Chips under the title | 3–4 lowercase, kebab or single words. Concrete, searchable ("approval", "hitl", "fallback"). |
| `capabilities` | Capability chips + est. cost | The exact `ctx.sapiom.*` capability ids the source calls. Must match the code (see "Capability ids"). |
| `whatItDoes` | "What it does" (Overview tab) | **The beats.** 3–6 short sentences, capability-first, no jargon headline. See "What it does". |
| `steps[].description` | Node labels in the Definition graph | One plain sentence per step: what THIS step does. Preserve `name`/`next`/`terminal`/`capability` exactly. |

### `examples/<slug>/template.json` — the rich manifest (detail page)

| Field | Shows up as | Write it as |
|---|---|---|
| `longDescription` | "About" | 2–4 short paragraphs. The fuller story. Plain first; name the mechanism once, casually. |
| `useCases` | "Use cases" (bullets) | 3 bullets. Each starts with a verb. Concrete situations, not features. |
| `notes` | "Notes" | **How to run it.** Easy path first (Use this template), advanced path second. See "How to run it". |
| `examples` | "Examples" | Real `{ input, output }` pairs. Keep these accurate to the code; don't invent fields. |
| `author` | "By …" | `{ "name": "Sapiom", "url": "https://sapiom.ai/" }` for first-party. |

---

## Voice

- **Second person, present tense.** "It reads the request, ranks your options, and emails you a recommendation." Not "The agent will perform reversible preparation."
- **Lead with the plain-English claim; drop the mechanism in after, casually.** Good: "…and it only stores anything after you approve (`save_memory`)." Bad: "blocks on a durable `pauseUntilSignal` so the run survives at $0."
- **Short declarative sentences.** One idea each. Cut clauses.
- **No pitch.** Delete "the sharpest showcase of the platform's differentiator", "seamless", "powerful", "robust", "the X pattern, done right". State what it does; the reader decides if it's impressive.
- **Concrete over abstract.** "offer the job to your top pick, then fall down the shortlist" beats "a ranked sequential-fallback loop".
- **You can name a capability or primitive** (`models.run`, `pauseUntilSignal`, `web.search`) — once, in passing, not as the headline.

### Before → after (the house style, from a real edit)

> ❌ "The agent does reversible prep — parse the request (models.run), rank the candidates by
> fit, and notify the approver (email) — then blocks on a durable pauseUntilSignal so the run
> survives the wait at $0. The sharpest showcase of the platform's durability differentiator."

> ✅ "It reads the request, ranks your options, and emails the approver a recommendation —
> then pauses and waits, costing nothing while idle. Say no and it backs out cleanly; say yes
> and it offers the job to your top pick, falling down the shortlist until someone accepts."

---

## The tagline (`description`)

One sentence. Name what it does and, if it has a defining surface or trigger, name that too.
The shape that works: **[what it does], [notable trait]**.

- ✅ "An agent does the prep, then waits for a person to approve before it spends money or does anything it can't undo."
- ✅ "On a schedule, research a topic and email a short, sourced brief."
- ❌ "Do reversible work, pause for a human approval signal before committing, then commit via a ranked sequential-fallback loop." (three internal terms; reads like a commit message)

## What it does (`whatItDoes`)

The Overview. 3–6 short sentences. Open with who it's for or when to reach for it, then walk
the flow in plain terms. Name capabilities in passing, never as the lead.

Think of it as **named beats** — each sentence is one move the workflow makes:

> For work where an agent can do the legwork but a human makes the final call. It reads the
> request, ranks your options, and emails the approver its recommendation — then pauses and
> waits, costing nothing while idle. Say no and it backs out cleanly; say yes and it offers
> the job to your top pick, falling down the shortlist until someone accepts. The irreversible
> step only happens after a human approved *and* a candidate said yes — and if nobody does, it
> escalates to a person instead of failing quietly.

## About (`longDescription`)

2–4 short paragraphs — the same story with room to breathe. First paragraph: the plain
what-and-when. Middle: the interesting mechanics in plain terms (durability, branching,
fallbacks). Last: what it costs, stated simply ("You pay for the model reasoning and the
emails — the waiting is free."). Markdown is fine; bold sparingly.

## Use cases (`useCases`)

Exactly 3 bullets. Each starts with a verb and names a real situation:

- "Require sign-off before an agent spends money, books something, or signs a contract."
- "Fill a request from a shortlist — offer it to your top choice first, then fall back down the list until someone accepts."
- "Hand off to a person when the agent can't close the loop, instead of failing silently."

## How to run it (`notes`) — easy path first

This is the field users hit when they want to actually run the thing. **Lead with the
one-click webapp path; put the code/MCP path second, clearly optional.**

1. **Use this template.** "Click **Use this template** — Sapiom builds and deploys it for you,
   then run it from the workflow page. Your $5 signup credit covers first runs."
2. **Anything template-specific** the user must know to see it work — e.g. required inputs,
   a secret to set (BYO-API templates), or that it pauses on a real signal.
3. **Advanced (only if relevant):** "Prefer to work from the code? Run it locally with
   `run_local` to trace the whole flow for free, or edit and deploy it with the Sapiom MCP."

For templates that **pause on a live signal** (human-in-the-loop, wait-for-webhook), say so
plainly and show how to send the signal (today that's the MCP `workflow_signal` tool / the
API — there is no one-click signal button yet). Keep payloads short and correct.

---

## Capability ids (correctness, not style)

The `capabilities` array and each `steps[].capability` **must be the real `ctx.sapiom.*` ids
the source calls.** Mismatches make the gallery advertise a capability the deployed run never
uses, and skew the estimated cost.

- The LLM path is **`models.run`** (and `models.coding` for coding). It is **not** `llm.generate`
  — that is a catalog id that reads `coming_soon` and is never the runtime path.
- Cross-check against `index.ts`: grep for `ctx.sapiom.<x>` and list exactly those ids.
- Don't add a capability to the array that no step calls.

---

## The "easy path first" rule (applies everywhere)

Across `notes`, the detail page, and the "Build & run" tab, the **one-click "Use this template"
build+deploy** is the primary path and comes first. The local/MCP "edit the code" flow is the
advanced, opt-in path and comes second, framed conditionally ("Prefer to work from the code?").
Never present the MCP path as the only way to build and run — the webapp does it for you.

---

## Checklist (author or generating agent)

- [ ] `description`: one plain sentence, no internal jargon.
- [ ] `whatItDoes`: 3–6 short sentences, capability named in passing, no pitch words.
- [ ] `steps[].description`: one plain sentence each; `name`/`next`/`terminal`/`capability` unchanged.
- [ ] `capabilities`: exactly the `ctx.sapiom.*` ids the source calls (`models.run`, not `llm.generate`).
- [ ] `longDescription`: 2–4 short paragraphs; cost stated simply at the end.
- [ ] `useCases`: 3 verb-first bullets, concrete situations.
- [ ] `notes`: Use-this-template first; template-specific gotcha; advanced local path last.
- [ ] `examples`: accurate `{ input, output }`, no invented fields.
- [ ] Read it back out loud. If a sentence sounds like a release note or a pitch, rewrite it.
