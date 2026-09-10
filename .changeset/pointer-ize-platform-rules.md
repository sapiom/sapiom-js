---
"@sapiom/agent-core": minor
"@sapiom/mcp": minor
"@sapiom/tools": patch
"@sapiom/cli": patch
---

Stop restating the platform rules in npm-shipped files; point at the served copy
and stamp the pointer (SAP-3181).

The rules that are true of Sapiom regardless of the installed SDK — one-off call
vs agent, the capability catalog, database lifetime, trigger kinds, App Links,
which capability calls an LLM, composing deployed agents, platform vocabulary —
are served by the Sapiom API at `GET /v1/agents/authoring-rules`. Every copy
this repo used to ship of them was frozen at publish or scaffold time and could
never be corrected; that is how the 7-day database claim and the two-kind
trigger list reached customers.

- The `sapiom-agent-authoring` skill's platform chapters are now a short
  summary plus a pointer to the served section, bracketed by
  `<!-- section: … -->` markers so a Studio session can splice the served text
  in. The authoring mechanics (step model, directives, `ctx.shared`,
  pause/resume, stubs) are unchanged.
- Every scaffolded `AGENTS.md` (both `@sapiom/agent-core` templates, the
  `@sapiom/cli` template and all gallery examples) and `examples/AUTHORING.md`
  carry a one-paragraph pointer and a stamp:
  `<!-- sapiom-authoring-rules release=… digest=… -->`.
- `@sapiom/tools`' JSDoc on the `model` field of `llm.run`, `llm.submit`,
  `models.run` and `models.coding.run` points at the served rule instead of
  restating it.
- `sapiom_dev_agents_check` reads the stamps in the project's `AGENTS.md` and
  skill, makes one best-effort anonymous read of the served endpoint's
  `X-Sapiom-Content-*` headers, and warns when a stamp differs from the served
  copy. No stamp means no request; unreachable means no warning. The wording is
  "differs from", never "older than" — digests do not order.
- `@sapiom/agent-core` exports the stamp vocabulary
  (`AUTHORING_RULES_*`, `parseAuthoringRulesStamp`,
  `renderAuthoringRulesStamp`, `authoringRulesDriftWarning`), and
  `node scripts/authoring-rules-stamp.mjs --from-served` moves every stamp in
  the repo to the current release at once.
