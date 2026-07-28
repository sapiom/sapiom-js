---
"@sapiom/harness": minor
---

Studio: show a template's complexity band where the per-run cost estimate used to be.

The Templates dialog rendered `estCostPerRunUsd`, relayed from the same core endpoint the dashboard's Template library reads. Core stopped serving that field: it could only price capabilities metered per `call`, so the estimate was `null` for 21 of 26 templates, and a number that honest for 5 of them was not worth a slot on every card. Core now derives a **complexity band** — `Minimal` through `Advanced`, 1–5 — from each template's declared shape.

Without this change nothing errored, which is why it would have gone unnoticed: `template-catalog.ts`'s defensive narrowing turned the missing field into `null` and the formatter turned that into an em dash, so **every** template read `—` where a cost used to be.

`TemplateSummary.estCostPerRunUsd` is replaced by `TemplateSummary.complexity`, and the new `TemplateComplexity` / `TemplateComplexityBasis` types are exported alongside it. **Breaking for embedders** (hence `minor`): `src/index.ts` re-exports `./shared/types.js`, so code reading `estCostPerRunUsd` off a summary stops compiling.

The band is read, never computed. Whether core derives it (today) or serves an authored one later, this surface is unchanged.

`complexity` is typed nullable here even though core types it required, and that is deliberate rather than belt-and-braces. This is a published npm package: an old copy can point at any backend, and a fresh copy can point at a backend that predates the field — a local stack, a self-hosted one, production before a promotion. An unguarded dereference in the row renderer would take out the whole dialog, so a band that isn't there degrades that one row to an em dash instead. Note the glyph's meaning has changed: it used to mean "no cost estimate exists", the majority case; it now means "this response predates the band", and nobody should ever see it against a current backend.

On the card the band rides beside the step count, with the counts behind it in the tooltip. In the detail pane, the section retitles to "Capabilities and complexity" and the old three-state cost note collapses to a single line — the band plus what produced it ("2 model steps, 1 chained, 5 steps, 1 capability"), so it reads as an estimate of shape rather than an opaque verdict. Text only, no meter or dots, matching the dashboard's gallery.
