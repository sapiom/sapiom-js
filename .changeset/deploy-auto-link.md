---
"@sapiom/harness": patch
---

Deploy now links (or creates) the remote agent for a project that has never
been linked, instead of failing.

A gallery-template clone lands with `sapiom.json` carrying its fork provenance
and no `definitionId` — by design, since the definition was always meant to be
created at deploy. That half was missing, so `POST /api/workflows/:id/deploy`
answered 409 "workflow is not linked to a Sapiom agent" and the Deploy button
could not succeed on a fresh template.

The route now resolves-or-creates the agent first (`link({ create: true })`,
which matches an existing definition by name/slug before creating one, so
re-deploying never duplicates it), caches the id in `sapiom.json`, and continues
into the build. The stream gains a non-terminal `linking` line so the UI can say
what it is doing; terminal lines are unchanged. The agent is named after its
declared `defineAgent({ name })` where resolvable, falling back to the cached
name or the workflow's own name. An unparseable `sapiom.json` still 409s — now
with a message that says so, because creating a remote agent we could not
record would orphan it.

Caching the newly-linked id in `sapiom.json` is best-effort: the file is a
re-resolvable cache and `link` re-resolves the same agent by name, so a failed
write (read-only checkout, a permissions error, the config turning invalid
between the initial check and this write) must not cost the user their build.
On that path the stream emits a non-terminal `warning` line instead of failing
— the agent was created on Sapiom but not recorded locally, so the Deployed
chip will not flip and the next deploy re-links, but nothing is duplicated
because `link` resolves the same agent again. The SPA renders both the
`linking` and `warning` lines, and a double-click on Deploy can no longer
create two remote agents for the same project.

Because linking matches by name, two gallery clones of the same template —
which share the same declared `defineAgent({ name })` — resolve to the same
remote agent, so deploying the second one replaces the first's build; this is
inherent to link-by-name (unchanged from `sapiom agents link --create`), not
a new bug, but it's now reachable from a single button click.
