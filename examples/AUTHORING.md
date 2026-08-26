# Authoring Sapiom templates

A **template** is a working Sapiom agent, published in this repo, that anyone can browse in
the gallery and turn into their own agent with one click. This guide takes you from an
empty directory to a merged, live template. Contributions are welcome — a human or an agent
can follow it end to end.

The path is five steps:

1. **[Develop](#1-develop)** — write the agent and its manifest in a new directory, against
   the bar in **[Make it runnable with nothing](#1a-make-it-runnable-with-nothing)**: `{}` in,
   a real terminal run out.
2. **[Build & test](#2-build--test)** — compile it, run it deployed with `{}`, validate the files.
3. **[Categorize](#3-categorize)** — set its category, discipline, cadence, complexity, and step kinds.
4. **[Write the copy](#4-write-the-copy)** — the words a user reads. This is most of the work.
5. **[Submit](#5-submit)** — open a PR; once merged, Sapiom picks it up automatically.

If you only remember one thing: **write for the person deciding whether to use this, not
for the person who built it.** Plain, concrete, second-person. No pitch.

---

## 1. Develop

Every template is one directory under `examples/`, named for its `id` (kebab-case, e.g.
`examples/scheduled-research-brief`). Look at an existing one — `examples/hello-agent` is the
smallest — and copy its shape. A template directory holds:

| File                             | What it is                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `index.ts`                       | The agent itself — a `defineAgent` / `defineStep` graph. This is the code that runs.                  |
| `template.json`                  | The rich manifest for the detail page (`longDescription`, `useCases`, `notes`, `examples`, `author`). |
| `package.json` / `tsconfig.json` | Pinned `@sapiom/*` SDK deps and a `typecheck` script. Copy these from an existing template.           |
| `README.md`                      | Short, optional — how to run it from the code.                                                        |

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

## 1a. Make it runnable with nothing

**The rule: a user who clicks "Use this template" and then "Run once", supplying nothing at
all, must get a run that reaches a terminal state and produces something real.** No inputs, no
secrets, no database, no connected accounts. A template that needs setup before it does
anything is not ready to publish.

"Something real" does not mean "something faked". The rule that resolves every case:

> **Simulate the world's _response_. Never simulate your _effect_ on the world.**

A stand-in search result, sample transcript, or seeded database row is fine — you are supplying
an input the user would have supplied. Reporting that you sent an email, posted to Slack,
pushed a commit, or filed an attestation when you did not is never fine, however it is
labelled. The user's next action is to go and look.

| ✅ Honest                                                  | ❌ Dishonest                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `{ posted: false, skipped: "no-credential" }`              | `{ posted: true }` with no token                              |
| Seeded demo rows in a provisioned database                 | A hardcoded `rows` array posing as the user's data            |
| `{ status: "draft", previewUrl: null }`                    | `{ status: "published", url: "…" }` for a site never deployed |
| `{ outcome: "pending-approval", pending: true }` at a gate | `{ approved: true }` because nobody answered                  |

### Every required input needs a default, and no entry step throws

```ts
const entryInput = z.object({
  topic: z.string().min(1).default("AI agent reliability incidents"),
  lookbackDays: z.number().int().positive().default(7),
});
```

A missing or malformed input is an expected outcome, not a crash — route it to a `rejected`
terminal so the run completes with a readable reason:

```ts
// ❌ throw new Error("`source` is required");
if (source === "") return goto("rejected", { reason: "`source` is required" });
```

**Defaults are safe for settings, never for resources.** A **setting** is non-secret config (a
topic, a recipient, a row cap) — give it a real default. A **resource** must _exist_: a
repository, a database, a sandbox. Never default one to a plausible-looking name;
`repoSlug: "my-app"` and `dbHandle: "analytics"` do not exist in a new account, and naming them
turns a clean rejection into a 404 mid-run. Declare it under `resources[]` and provision it, or
stop with a stated reason. A **connection** is a third-party credential: never default it and
never fake it — read it, and when it is absent, skip the side effect and say so.

### Provisioning an inbox: never pin a global identifier

Sending email needs an inbox to send from. Provision it, but let the platform pick the address —
**never pass a fixed `username` to `inboxes.create`.** AgentMail addresses are globally unique, so
a hardcoded local part (`"newsletter"`, `"outreach"`) can be owned by only ONE account across the
whole platform: the first tenant to run your template claims it, and every other tenant's `create`
then 409s with "Email address is already taken" — an uncaught throw that fails the very first
zero-setup run. Omit `username` so the address is auto-generated, reuse an existing inbox first,
and treat a 409 as "someone already provisioned one" (the non-atomic window between `list` and
`create`) rather than a crash:

```ts
import { EmailHttpError } from "@sapiom/tools";

async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  try {
    const inbox = await ctx.sapiom.email.inboxes.create({
      displayName: "My Agent",
    });
    return inbox.inboxId;
  } catch (err) {
    if (err instanceof EmailHttpError && err.status === 409) {
      const retry = await ctx.sapiom.email.inboxes.list({ limit: 1 });
      if (retry.inboxes.length > 0) return retry.inboxes[0].inboxId;
    }
    throw err;
  }
}
```

The same caution applies to anything keyed by a platform-global name: prefer a tenant-scoped
handle or a platform-generated identifier over a string every tenant would otherwise reuse.

### Pause discipline

Before you write a pause, decide **who fires the signal**, because a zero-config run has no
answer for most of them.

**Machine wait** — a render job, a coding agent, a webhook callback, a drip interval. If the
thing that would fire the signal does not exist, **do not pause**: take a fallback path and
label it in the output.

```ts
// Nothing will call back on an unconfigured run — use the fallback and keep going.
if (!callbackRegistered) return goto("decide", {});
return pauseUntilSignal({
  signal: SIGNAL,
  resumeStep: "decide",
  correlationId: ctx.executionId,
});
```

**Human checkpoint** — `kind: "pause"` **and** `checkpoint: true`, at most one per template.
Where a participant _is_ assigned, **keep the pause**: that is correct behaviour, and the run
detail already ships one-click Approve/Reject. Where nobody is assigned, **terminate at the
gate** with the pending artifact and the signal that continues the run:

```ts
if (!approver) {
  // The artifact awaiting a decision, and how to continue.
  return goto("pending", { artifact: draft, unmet: ["approver"], note });
}
```

**Never auto-approve a checkpoint, and never auto-resume one into a rejection.** Fabricating
human consent is the worst output a template can produce. Auto-resuming into `rejected` is
honest but reads to a first-run user as "the demo broke", and teaches the inverse of the lesson.

### Say what you skipped

A run that took a degraded branch names it in its own output — `unmet[]` for the requirement
keys it did not have, and one plain sentence in `note` for the person reading the result:

```ts
return goto("posted", {
  posted: false,
  skipped: "no-credential",
  unmet: ["SLACK_BOT_TOKEN"],
  note: "No `SLACK_BOT_TOKEN` is set, so nothing was posted to Slack. The message above is what would have been sent.",
});
```

### Credentials come from the environment, never from a store you name

Declare each third-party credential under `requiredSecrets[]` and read it as
`process.env[KEY]`. Sapiom collects it when the user takes the template and injects it into the
step at dispatch. Do **not** call `ctx.sapiom.vault.get(ref, key)` for a template credential:
that reads a tenant-wide ref the deploy panel never writes, so a user who fills in the dialog
still gets `skipped: "no-credential"`. Declaring what a credential _is_, rather than where it
lives, is what lets resolution change without touching your template.

Supplying config or a credential never requires a redeploy: settings are run input read per
run, and secrets are read at step dispatch.

## 2. Build & test

1. **Compile.** From your template directory: `npm install`, then `npm run typecheck`. It must
   pass — the gallery only ships templates that build.
2. **Trace a run for free.** Drive the agent through the Sapiom MCP: `run_local` executes the
   whole graph locally and traces every step without spending anything, so you can watch the
   flow before you deploy. The lifecycle is `check → run_local → link → deploy → run`; each
   template's `README.md` shows it.

   **Be aware of what it does not check.** Every capability is stubbed, so `database.get`
   returns a `localhost` connection string and `repositories.get` returns a plausible
   repository — _neither ever fails_. A `run_local` pass proves your control flow, **not** that
   the resources your template names exist. Pauses are auto-resumed locally too, so a pause
   nothing will ever fire still looks fine.

3. **Then run it deployed, with no input at all.** `deploy` and `run` it with `{}`. It must
   reach a terminal state and produce something real (see [§1a](#1a-make-it-runnable-with-nothing)).
   This is the check that catches what `run_local` cannot: a resource handle that doesn't
   exist, a pause with no resumer, a required input with no default. Assert on the trace —
   `steps[].directive` — not on the status.
4. **Validate the registry and your manifest.** Run `pnpm examples:check` from the repo root.
   It checks that `registry.json` matches the schema (including a valid `category`, `discipline`,
   `cadence`, `complexity`, and step `kind`), is sorted by `id`, that your `discipline` is one
   allowed under your `category`, that every `sourcePath` points at a real
   directory with a `template.json`, that any `checkpoint` is a single genuine human gate, that
   your `complexity` doesn't sit 2+ bands from the one derived from your declared shape, and
   that **each `template.json` matches `template.schema.json`**. The manifest schema is
   `additionalProperties: false`, so a mistyped field name fails here rather than being
   silently dropped by the backend parser. Run `pnpm examples:sort` first to put your entry in
   order.
5. **Get the capability ids right.** The `capabilities` array and each `steps[].capability`
   must be the exact `ctx.sapiom.*` ids your code actually calls — see
   [Capability ids](#capability-ids-correctness-not-style). One-shot LLM work uses
   `llm.run`; managed multi-turn loops use `models.run`, and coding agents use
   `models.coding`. The runtime path is **not** `llm.generate`.
6. **Keep the manifest runnable, not just honest.** The `examples` you list must be real
   `{ input, output }` pairs the code produces — don't invent fields. And `examples[0].input`
   must **produce a terminal run when deployed**: in particular it must not name a resource (a
   repo, a database, a sandbox, a domain) that a brand-new account will not have. Under
   `run_local` those calls are stubbed and never 404, so a placeholder passes locally and fails
   for every real user.

## 3. Categorize

Set five things in your `registry.json` entry: one `category`, one `discipline`, one `cadence`,
one `complexity`, and a `kind` on every step. They drive how the gallery groups, filters, and
describes your template.

### `category` — the outcome, not the mechanism

Pick **exactly one**. The question it answers is _"what is the user trying to produce?"_ — the
business job, not the platform primitive you're demonstrating. A durable pause-and-resume drip
that books meetings is `revenue-marketing`, not "durable"; the durability is _how_, not _what_.

| `category`               | What belongs here                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starter`                | Learning the platform — the smallest thing that runs, or a primitive shown on its own. The one category that is about mechanism, because that is its job. |
| `product-engineering`    | Ship and maintain software: code review, dependency work, tests, quality gates.                                                                           |
| `reliability-governance` | Keep systems and processes healthy and accountable: triage, self-healing, approvals, fleet oversight.                                                     |
| `revenue-marketing`      | Win and keep customers: outreach, proposals, CRM, content, campaigns, creative.                                                                           |
| `customer-experience`    | Serve an existing customer: support resolution, onboarding, service channels.                                                                             |
| `data-knowledge`         | Turn data or sources into an answer: research, reporting, querying, backfills.                                                                            |
| `finance-legal-people`   | Money, compliance, contracts, and employment work.                                                                                                        |

Mechanism words — `durable`, `pause-resume`, `hitl`, `evals`, `media`, `orchestration` — belong
in freeform `tags`, which drive search and the chips on a card. Put them there and they stay
findable without competing with the outcome axis.

If nothing fits cleanly, pick the closest and say so in your PR — the enum can grow, and a
template that fits nowhere is useful signal. (The display label and section order are chosen by
the app; you only set the id.)

### `discipline` — the badge on your card

Same outcome axis, one zoom level in: `category` decides which gallery group your template files
under, `discipline` is the short label printed on the card itself. So two templates in one
category routinely differ — `pr-review-bot` and `dependency-upgrade` are both
`product-engineering`, but the first is `Engineering` and the second is `Release engineering`.

Unlike `category`, this string is rendered **verbatim** — it is not an id the app relabels, so
write it as you want it read. The app supplies only the glyph beside it.

| `category`               | Allowed `discipline`                                  |
| ------------------------ | ----------------------------------------------------- |
| `starter`                | `Starter`                                             |
| `product-engineering`    | `Engineering`, `Release engineering`, `AI operations` |
| `reliability-governance` | `Reliability`, `Security`, `Governance`, `FinOps`     |
| `revenue-marketing`      | `Revenue`, `Marketing`, `Strategy`                    |
| `customer-experience`    | `Support`, `Customer success`, `Product`              |
| `data-knowledge`         | `Data`, `Knowledge`, `Research`, `Operations`         |
| `finance-legal-people`   | `Finance`, `Legal`, `People`, `Operations`            |

The enum in `registry.schema.json` is the union of that whole column, so the schema will accept
`Support` on a `finance-legal-people` row — `pnpm examples:check` is what rejects it. Pick the
discipline from **your** category's row.

Omitting it is not fatal: the card falls back to a short label derived from your `category`. But
the fallback is one label for the whole group, so a card without a discipline is
indistinguishable from its neighbours.

### `cadence` — what starts a run

| `cadence`    | Use when                                                 |
| ------------ | -------------------------------------------------------- |
| `on-demand`  | A person or an API call starts it.                       |
| `scheduled`  | A cron trigger starts it.                                |
| `on-webhook` | An inbound webhook event starts it (e.g. a PR opening).  |
| `on-event`   | A request to an endpoint the template deploys starts it. |

This describes the **entry only**, not what happens mid-run. `wait-for-webhook` is `on-demand`:
you start it, and it pauses for a callback partway through. `pr-review-bot` is `on-webhook`:
the PR event itself is what starts it.

### `complexity` — how much judgment is in the output

**The axis is variance and judgment, not graph size.** A deterministic saga with a wide
fan-out is `simple` — `approval-chain` declares seven steps, two durable pauses, a reminder
loop and a compensation branch, but every branch is a state check and the answer is always
approve or reject. Two chained model steps are not simple, however short the graph: each one's
output is the next one's input, so drift compounds and there is no single place to inspect the
result. Steps, capabilities and fan-out are a **tiebreak**, never the reason for a band.

To pick a band, count the template's **judgment points** — the places where something
non-deterministic is produced:

- a step with `kind: "llm"` (a model call — `llm.run`, `models.run`, `models.coding`),
- a generated image or video (`content.generation.*`),
- a capability that synthesizes prose for you, e.g. `web.search`'s `answer` field. It counts
  even with no `llm` step in the graph, because the user still reads model-written output.

| `complexity` | Use when                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal`    | **No judgment points.** Re-run it with the same input and you get the same output. A greeting, a Slack post, a health check.                                                                                                                    |
| `simple`     | **One judgment point**, and you can read the output and tell at a glance whether it's right. Also: any fully deterministic template whose scaffolding is substantial — durable checkpoints, a compensation branch, several capabilities.        |
| `moderate`   | **Two judgment points**, or one whose output then drives structured work — a branch, a database write, a rendered artifact — so a bad generation has a consequence past the text itself.                                                        |
| `involved`   | **Three judgment points**, or one to two whose output drives something **irreversible or outward-facing**: mail to a real prospect, SQL against your database, a deployed endpoint, a filed attestation. Checking it means checking each stage. |
| `advanced`   | **Chained judgment** — a model consuming another model's output, or a coding agent whose artifact is then built and deployed. Error compounds across stages. Three or more chained generative stages land here regardless of graph size.        |

Then apply the nudge, **at most one band, and only upward**: raise it if the deterministic
scaffolding around those judgment points is heavy (many distinct capabilities, a resumable
loop, a saga rollback), or if a judgment point's output drives something you can't take back.
Don't nudge for step count alone. If two bands still feel equally right, pick the lower one —
the gallery over-promising difficulty costs a user a template they could have used.

`pnpm examples:check` validates the enum, and warns when your band sits **2+ bands** from the
score derived from `steps[].kind` and `capabilities`. That gap means one of two things, and
both want a human: your label is wrong, or your **declared shape** is wrong — a step that
calls a model but says `kind: "compute"` also draws the wrong glyph in the gallery graph. Fix
whichever is actually untrue; don't inflate the label to silence the warning.

One band apart is expected and prints as a `note:`, not a warning. That is where the rubric
and the scorer legitimately disagree — the scorer can't see a synthesizing capability, so
`web-research-digest` derives `minimal` while its authored band is `simple`. Leave those alone.

### `kind` and `checkpoint` — what each step is

Set `kind` on every step:

| `kind`       | Use when                                            |
| ------------ | --------------------------------------------------- |
| `capability` | It calls a priced catalog capability.               |
| `llm`        | It calls a model (`llm.run`, `models.run`, `models.coding`). |
| `compute`    | In-process logic, a branch, or a terminal.          |
| `pause`      | It suspends the run at $0 until something wakes it. |

A step that calls a capability _and then_ suspends is `pause` — suspending is what defines it.

Then set `checkpoint: true` on the **one** step, if any, where **a person must approve** before
the run proceeds. This is much narrower than `pause`: most pauses are machine waits — a render
job finishing, a webhook arriving, a drip interval elapsing — and marking one would make the
gallery advertise "waiting for a video to encode" as an approval boundary. Mark it only where a
human decides. Most templates have no checkpoint, and that is the honest answer.
`pnpm examples:check` fails if a checkpoint is not a `pause`, or if a template declares more
than one.

## 4. Write the copy

This is most of the work, and where a template earns its place. The rest of this guide is the
copy contract: what each field is, and the voice every template shares. Read it for the person
choosing whether to use your template.

---

## Where the copy lives

Two files per template feed the UI. Keep them consistent — the same template, described
the same way, at two levels of depth.

### House-style limits (`pnpm examples:check` enforces)

The gallery card has finite room, and the rules below are sized from it — a name that wraps the
title or a use case that can't sit on a chip is a layout bug, not a matter of taste.

| Field         | Limit                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | ≤ 32 chars. No `→`, no `/`, no parentheticals, no mechanism word (`saga`, `engine`, `pipeline`, `runner`, `endpoint`, `gate`, `durable`, `keep-alive`, …). |
| `description` | ≤ 160 chars — one plain sentence.                                                                                                                          |
| `whatItDoes`  | ≤ 320 chars, and **lead with the verb**. "Create a cited account brief…", not "For turning a…".                                                            |
| `useCases[]`  | ≤ 40 chars each — a short noun phrase ("Relationship graph"), not a sentence.                                                                              |

**Name the outcome, not the machinery.** This is the same rule `category` already follows: the axis
is _"what am I trying to produce?"_ Mechanism words belong in `tags`, which is what drives search —
putting one in the name doesn't make it more findable, it just spends the title on it.

Every current template meets these, so they are hard failures — the lengths come from the schemas
(`maxLength`, reported with a JSON pointer) and the style rules from the check, which names the
offending word.

### `examples/registry.json` — the gallery index (one entry per template)

| Field                 | Shows up as                         | Write it as                                                                                                                      |
| --------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `name`                | Card title, detail H1               | Title Case, human, ≤32 chars. Name the **outcome**: "Approval Before Action", not "Human-in-the-Loop Approval" and not the slug. |
| `description`         | Card subtitle, detail subtitle      | **One sentence.** What it does, in plain words. See "The tagline" below.                                                         |
| `tags`                | Chips under the title               | 3–4 lowercase, kebab or single words. Concrete, searchable ("approval", "hitl", "fallback"). This is where mechanism words go.   |
| `category`            | Which gallery group it files under  | One id from the enum. The **outcome**, not the mechanism — see [Categorize](#3-categorize).                                      |
| `discipline`          | The badge printed on the card       | One value from **your category's** row, rendered verbatim — see [Categorize](#3-categorize).                                     |
| `cadence`             | The "Trigger" fact                  | One id from the enum. What **starts** a run, not what it does mid-run — see [Categorize](#3-categorize).                         |
| `complexity`          | The "Complexity" band               | One id from the enum. Variance and judgment in the output, **not** graph size — see [Categorize](#3-categorize).                 |
| `capabilities`        | Capability chips + est. cost        | The exact `ctx.sapiom.*` capability ids the source calls. Must match the code (see "Capability ids").                            |
| `steps[].description` | Node labels in the Definition graph | One plain sentence per step: what THIS step does. Preserve `name`/`next`/`terminal`/`capability` exactly.                        |
| `steps[].kind`        | The step's glyph in the graph       | `capability` / `llm` / `compute` / `pause`, one per step — see [Categorize](#3-categorize).                                      |
| `steps[].checkpoint`  | The "Checkpoint" fact               | `true` on the single step where a **person** approves, or omit. Never on a machine wait.                                         |

### `examples/<slug>/template.json` — the rich manifest (detail page)

| Field             | Shows up as                      | Write it as                                                                                                                     |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `whatItDoes`      | "What it does" (the card's lead) | ≤320 chars, about three sentences, **verb first**. "Create a cited account brief…", never "For turning a…". See "What it does". |
| `longDescription` | "About"                          | 2–4 short paragraphs. The fuller story. Plain first; name the mechanism once, casually.                                         |
| `useCases`        | "Use cases" (chips)              | Exactly 3, each ≤40 chars. Short noun phrases — "Relationship graph", not a sentence.                                           |
| `notes`           | "Notes"                          | **How to run it.** Easy path first (Use this template), advanced path second. See "How to run it".                              |
| `examples`        | "Examples"                       | Real `{ input, output }` pairs. Keep these accurate to the code; don't invent fields.                                           |
| `author`          | "By …"                           | `{ "name": "Sapiom", "url": "https://sapiom.ai/" }` for first-party.                                                            |

#### What the template needs to run (all optional, all machine-read)

These four say what a run requires **before** anyone clicks Run, so the UI can be honest about it.
A declaration says what a thing **is**, never where it is stored — there is no `vaultRef`, no
`connectorId`, no `store`, and there never will be. Storage belongs to the resolver, which is what
lets it change without touching your template.

| Field             | Shows up as                                                                        | Write it as                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources`       | "Sapiom will provision" in the setup panel, and the cost/lifetime line on the card | The managed things a run creates — a Postgres, a sandbox, a repo, an inbox. Each needs a `kind` and a `handle` (the slug your step code passes to `ctx.sapiom.database.get()`; unique within a template). `duration` is postgres-only, caps at **7d, and there is no renew verb** — if your template needs state that outlives that, say so in `notes` and set `ephemeral: false`. `seed` is read-side only; see below.                             |
| `requiredSecrets` | The credential dialog on "Use this template"                                       | Only credentials **Sapiom cannot broker** — a Slack token, the customer's own DB. Never a Sapiom API key, never a non-secret value. Each needs `key`, `label`, `provider`; `key` follows process-env rules — not `PATH`, not `SAPIOM_*`, not `WORKFLOWS_*`. Mark `optional: true` only when the run still reaches a terminal state without it and says what it skipped.                                                                             |
| `settings`        | Ordinary form fields, merged into the run input                                    | Non-secret config — a recipient, a lookback window, a row cap. **This is where a `RECIPIENT` belongs, not the vault**, which can't be listed, validated, or prompted for. `default` is required: a setting without one can't support a zero-interaction run, which is the point.                                                                                                                                                                    |
| `defaultInput`    | The one-click Run path                                                             | The input a run starts with when the user supplies nothing. Merged **under** the user's input and under `settings` defaults, so an explicit value always wins. **Not the same as `examples[0].input`**, which is documentation and may legitimately hold a repo slug or a live URL that won't work on a fresh tenant. It never overrides your code's own defaults.                                                                                  |
| `zeroSetup`       | The shelf's "runs with no setup" claim                                             | What an unconfigured run actually reaches: a `terminalState`, optional `expect[]` assertions over the terminal artifact (`nonEmptyArray`, `nonEmptyString`, `minLength`, `matches`, `equals`, `absent`), and a one-sentence `narrative`. Assert that the pattern **demonstrably ran and the output is honest about it** — not that the result is production-grade. The narrative renders verbatim, so it must never imply a send that won't happen. |

#### `seed`: only seed what your template READS

A freshly-provisioned database is empty, so a template that reads from one runs green and
produces nothing — terminal, honest-looking, and useless as a first impression. `seed` fixes
exactly that case and no other.

**The rule is not "give every resource a seed."** Look at what the table is _for_:

| Your table is…                                                                                    | Seed it? | Why                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Input** the template reads and did not write — a leads list, a metrics table, a corpus to query | **Yes**  | Otherwise the first run has nothing to work on. `nl-db-query-endpoint`, `scheduled-db-insight-report`, `personalized-media-at-scale`, `durable-backfill`.                                                                           |
| **Output** the template itself writes — a log, a CRM store, a dedupe index, an audit trail        | **No**   | Seeding fabricates records a user might act on. `approval-chain`, `cold-outreach-engine`, `error-triage-digest`, `meeting-notes-crm`, `the-brain` all create and insert their own tables; an empty one on the first run is correct. |

If you're unsure, ask whether a user reading the row would think a real thing happened. If yes,
don't seed it.

This is **not** canned capability responses. Sample mode was cut, and deliberately: a run
labelled "sample" that really posts to Slack is a hazard. A real resource with real seed data
means a real run — nothing pretends.

`pnpm examples:check` fails if a declared `seed` file isn't in the example directory.

---

## Voice

- **Second person, present tense.** "It reads the request, ranks your options, and emails you a recommendation." Not "The agent will perform reversible preparation."
- **Lead with the plain-English claim; drop the mechanism in after, casually.** Good: "…and it only stores anything after you approve (`save_memory`)." Bad: "blocks on a durable `pauseUntilSignal` so the run survives at $0."
- **Short declarative sentences.** One idea each. Cut clauses.
- **No pitch.** Delete "the sharpest showcase of the platform's differentiator", "seamless", "powerful", "robust", "the X pattern, done right". State what it does; the reader decides if it's impressive.
- **Concrete over abstract.** "offer the job to your top pick, then fall down the shortlist" beats "a ranked sequential-fallback loop".
- **You can name a capability or primitive** (`llm.run`, `pauseUntilSignal`, `web.search`) — once, in passing, not as the headline.

### Before → after (the house style, from a real edit)

> ❌ "The agent does reversible prep — parse the request (llm.run), rank the candidates by
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

The card's lead. **≤320 characters, about three sentences, and it opens with a verb.** Say what
it produces, then walk the flow in plain terms. Name capabilities in passing, never as the lead.

**Do not open with the audience.** "For work where an agent can…" spends the first and most-read
words on who it's for instead of what it makes. 19 of the original 26 did this; none do now, and
`pnpm examples:check` rejects a leading "For".

Think of it as **named beats** — each sentence is one move the agent makes:

> Do the legwork, then wait for a person before spending money or doing anything irreversible.
> It ranks your candidates by fit and emails the top pick for approval, falling to the next on
> the list if that one declines, and hands off to a human rather than failing quietly.

The longer form below shows the same template written before the cap — useful for seeing which
detail belongs in `longDescription` instead:

> For work where an agent can do the legwork but a human makes the final call. It reads the
> request, ranks your options, and emails the approver its recommendation — then pauses and
> waits, costing nothing while idle. Say no and it backs out cleanly; say yes and it offers
> the job to your top pick, falling down the shortlist until someone accepts. The irreversible
> step only happens after a human approved _and_ a candidate said yes — and if nobody does, it
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
   then run it from the agent page. Your $5 signup credit covers first runs."
2. **Anything template-specific** the user must know to see it work — e.g. required inputs,
   a secret to set (BYO-API templates), or that it pauses on a real signal.
3. **Advanced (only if relevant):** "Prefer to work from the code? Run it locally with
   `run_local` to trace the whole flow with no Sapiom capability spend, or edit and deploy it with the Sapiom MCP."

For templates that **pause on a live signal** (human-in-the-loop, wait-for-webhook), say so
plainly and show how to send the signal (today that's the MCP `workflow_signal` tool / the
API — there is no one-click signal button yet). Keep payloads short and correct.

---

## Capability ids (correctness, not style)

The `capabilities` array and each `steps[].capability` **must be the real `ctx.sapiom.*` ids
the source calls.** Mismatches make the gallery advertise a capability the deployed run never
uses, and skew the estimated cost.

- One-shot LLM work uses **`llm.run`**. Use `models.run` only for a managed
  multi-turn loop, and `models.coding` for a coding agent. None of these runtime
  paths is `llm.generate`, a catalog id that reads `coming_soon`.
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
   points at a directory with no `template.json`, or your `template.json` doesn't match the
   manifest schema.
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
- [ ] Traced a `run_local` end to end with no Sapiom capability spend, understanding that it stubs every capability while ordinary author-code side effects remain real.
- [ ] **Deployed it and ran it with `{}` — it reached a terminal state and produced something real.**
- [ ] Every entry-step input has a default; no entry step `throw`s.
- [ ] No default names a resource a new account wouldn't have.
- [ ] Every pause has a known resumer, or a labelled fallback for when it doesn't.
- [ ] No `checkpoint` auto-approves or auto-resumes; with nobody assigned it terminates at the gate.
- [ ] Every credential is read from `process.env[KEY]` and declared in `requiredSecrets`; no config filed as a secret.
- [ ] Nothing in the output claims an effect on the world that did not happen; a degraded branch names itself in `unmet[]` and `note`.
- [ ] One `category` (the outcome, not the mechanism) and one `cadence`; `tags` kept freeform.
- [ ] One `discipline`, taken from your `category`'s row — the enum alone will not catch a wrong pair.
- [ ] One `complexity`, picked by counting judgment points — not by counting steps.
- [ ] A `kind` on every step, and `checkpoint: true` only on a real human approval gate.
- [ ] `pnpm examples:sort` then `pnpm examples:check` both clean.

**Copy**

- [ ] `name`: ≤32 chars, names the outcome; no arrow, slash, parenthetical, or mechanism word.
- [ ] `description`: one plain sentence, ≤160 chars, no internal jargon.
- [ ] `whatItDoes`: ≤320 chars, verb-first, capability named in passing, no pitch words.
- [ ] `steps[].description`: one plain sentence each; `name`/`next`/`terminal`/`capability` unchanged.
- [ ] `capabilities`: exactly the `ctx.sapiom.*` ids the source calls (`llm.run`, not `llm.generate`).
- [ ] `longDescription`: 2–4 short paragraphs; cost stated simply at the end.
- [ ] `useCases`: exactly 3, each ≤40 chars, short noun phrases.
- [ ] `notes`: Use-this-template first; template-specific gotcha; advanced local path last.
- [ ] `examples`: accurate `{ input, output }`, no invented fields.
- [ ] Read it back out loud. If a sentence sounds like a release note or a pitch, rewrite it.
