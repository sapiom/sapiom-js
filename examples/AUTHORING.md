# Authoring Sapiom templates

A **template** is a working Sapiom agent, published in this repo, that anyone can browse in
the gallery and turn into their own workflow with one click. This guide takes you from an
empty directory to a merged, live template. Contributions are welcome — a human or an agent
can follow it end to end.

The path is five steps:

1. **[Develop](#1-develop)** — write the agent and its manifest in a new directory.
2. **[Build & test](#2-build--test)** — compile it, trace a run for free, and validate the files.
3. **[Categorize](#3-categorize)** — pick the one category it belongs in.
4. **[Write the copy](#4-write-the-copy)** — the words a user reads. This is most of the work.
5. **[Submit](#5-submit)** — open a PR; once merged, Sapiom picks it up automatically.

If you only remember one thing: **write for the person deciding whether to use this, not
for the person who built it.** Plain, concrete, second-person. No pitch.

---

## 1. Develop

Every template is one directory under `examples/`, named for its `id` (kebab-case, e.g.
`examples/scheduled-research-brief`). Look at an existing one — `examples/hello-agent` is the
smallest — and copy its shape. A template directory holds:

| File | What it is |
|---|---|
| `index.ts` | The agent itself — a `defineAgent` / `defineStep` graph. This is the code that runs. |
| `template.json` | The rich manifest for the detail page (`longDescription`, `useCases`, `notes`, `examples`, `author`). |
| `package.json` / `tsconfig.json` | Pinned `@sapiom/*` SDK deps and a `typecheck` script. Copy these from an existing template. |
| `README.md` | Short, optional — how to run it from the code. |

Plus **one entry** in `examples/registry.json` — the gallery index (see
[Write the copy](#4-write-the-copy) for every field). That entry's `sourcePath` must point at
your directory (`examples/<id>`), and its `id` must match the directory name.

Write the agent by importing from the SDK packages the same way the existing templates do
(`import { defineAgent, defineStep, terminate } from "@sapiom/agent";`). Each step declares
its allowed transitions (`next` / `terminal`); the return type is derived from them, so an
undeclared transition is a compile error. Reach a real capability through the run context
(`ctx.sapiom.*`) — a web search, an LLM call, an email, a sandbox.

**Iterating against unreleased SDK changes (advanced, optional).** If you need SDK edits that
aren't published to npm yet, publish the workspace packages to a local registry and point your
template at them: `pnpm registry:local` in one shell, `pnpm publish:local` in another. Most
authors don't need this — the published `@sapiom/*` versions are enough.

## 2. Build & test

1. **Compile.** From your template directory: `npm install`, then `npm run typecheck`. It must
   pass — the gallery only ships templates that build.
2. **Trace a run for free.** Drive the agent through the Sapiom MCP: `run_local` executes the
   whole graph locally and traces every step without spending anything, so you can watch the
   flow before you deploy. The lifecycle is `check → run_local → link → deploy → run`; each
   template's `README.md` shows it.
3. **Validate the registry.** Run `pnpm examples:check` from the repo root. It checks that
   `registry.json` matches the schema (including a valid `category`), is sorted by `id`, and
   that every `sourcePath` points at a real directory with a `template.json`. Run
   `pnpm examples:sort` first to put your entry in order.
4. **Get the capability ids right.** The `capabilities` array and each `steps[].capability`
   must be the exact `ctx.sapiom.*` ids your code actually calls — see
   [Capability ids](#capability-ids-correctness-not-style). The LLM path is `models.run`
   (`models.coding` for a coding agent), **not** `llm.generate`.
5. **Keep the manifest honest.** The `examples` you list must be real `{ input, output }` pairs
   the code produces — don't invent fields.

## 3. Categorize

Pick **exactly one** `category` for your template and set it in its `registry.json` entry. It's
the primary way the gallery groups templates. Keep `tags` freeform for secondary browse and
search — the category is the one bucket, the tags are everything else.

| `category` | What belongs here |
|---|---|
| `starter` | Minimal, get-started templates — the smallest thing that runs. |
| `research` | Search / read the web and produce a sourced result. |
| `media` | Generate images, audio, or video. |
| `durable` | Long-running or async — pause on a webhook, drip over time, self-heal on a schedule. |
| `human-in-the-loop` | Pause for a person to approve before an irreversible step. |
| `quality` | Score, judge, or review an output against a bar. |
| `orchestration` | Coordinate or manage other workflows. |

If none fits cleanly, pick the closest and mention it in your PR — the list can grow. (The
display label, icon, and section order are chosen by the app; you only set the `category` id.)

## 4. Write the copy

This is most of the work, and where a template earns its place. The rest of this guide is the
copy contract: what each field is, and the voice every template shares. Read it for the person
choosing whether to use your template.

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

## 5. Submit

1. **Fork** this repo and branch off `main`.
2. **Add your directory** under `examples/` and your **one entry** in `examples/registry.json`.
3. **Sort and validate** locally: `pnpm examples:sort`, then `pnpm examples:check`. Both must be
   clean — the same check runs in CI and blocks the merge if the registry is invalid, unsorted,
   or points at a directory with no `template.json`.
4. **Open a pull request.** CI validates the registry and builds the SDK; an automated review
   runs too. Keep the PR to one template.
5. **On merge, it goes live.** The Sapiom backend reads `registry.json` at a pinned commit of
   this repo; once your change merges and that pin advances, your template shows up in the
   gallery, ready for anyone to use.

---

## Checklist (author or generating agent)

**Develop & test**

- [ ] One directory `examples/<id>/` with `index.ts`, `template.json`, `package.json`, `tsconfig.json`.
- [ ] `npm run typecheck` passes in the template directory.
- [ ] Traced a `run_local` end to end (free) before deploying.
- [ ] One `category` from the enum set; `tags` kept freeform.
- [ ] `pnpm examples:sort` then `pnpm examples:check` both clean.

**Copy**

- [ ] `description`: one plain sentence, no internal jargon.
- [ ] `whatItDoes`: 3–6 short sentences, capability named in passing, no pitch words.
- [ ] `steps[].description`: one plain sentence each; `name`/`next`/`terminal`/`capability` unchanged.
- [ ] `capabilities`: exactly the `ctx.sapiom.*` ids the source calls (`models.run`, not `llm.generate`).
- [ ] `longDescription`: 2–4 short paragraphs; cost stated simply at the end.
- [ ] `useCases`: 3 verb-first bullets, concrete situations.
- [ ] `notes`: Use-this-template first; template-specific gotcha; advanced local path last.
- [ ] `examples`: accurate `{ input, output }`, no invented fields.
- [ ] Read it back out loud. If a sentence sounds like a release note or a pitch, rewrite it.
