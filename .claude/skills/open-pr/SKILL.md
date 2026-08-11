---
name: open-pr
description: How to open (or fix) a pull request in this repo so the deterministic PR labeler accepts it — the body MUST follow .github/pull_request_template.md exactly or the PR is flagged `contribution: incomplete`. Use whenever asked to "open/make/create a PR", "push and PR", "fix the incomplete-contribution label", or when a PR was flagged by the labeler.
---

# Opening a pull request that passes the labeler

Every PR to `main` is classified by `.github/workflows/pr-labeler.yml` running
`scripts/pr-label-classifier.mjs` against the PR **body**. A body that doesn't
follow `.github/pull_request_template.md` gets the **`contribution: incomplete`**
label (the workflow logs say which check failed). The classifier re-runs on
`edited`/`synchronize`, so the fix is always: repair the body, never close the PR.

## The contract (what the classifier actually checks)

Start from `.github/pull_request_template.md` **verbatim** and fill it in. The
checker is prefix-matching and structural, so keep the template's own wording:

1. **All nine `##` sections present** (heading text must match): Problem and
   motivation · Summary and scope · Related work · Validation · Tests and
   documentation (a `###` under Validation counts) · Compatibility and release
   impact · Security · AI assistance · Checklist.
2. **Primary change type**: all six checkboxes present, **exactly one** checked
   (`[x]`). This also drives the type label (Feature → `enhancement`, …).
3. **Prose sections non-empty** after comments are stripped: Problem and
   motivation, Summary and scope. HTML comments don't count as content.
4. **Related work**: the line after `Related issue or discussion:` must be
   non-empty; a bare `N/A` is allowed for a direct PR.
5. **Validation**: must contain real commands/results — the untouched
   ```` ```text ```` block with only the `# command — result` placeholder counts
   as empty.
6. **Tests and documentation**: non-empty, or `N/A` **with a reason**.
7. **Compatibility and release impact**: both bullets must have a value after
   the colon — `- Breaking or externally visible changes: <something>` and
   `- Changeset: <Added …>` (or `N/A` **with a reason**). A changed published
   package really does need a `.changeset/*.md` (see #599's for the format).
8. **Security**: both checkboxes present and **both checked**.
9. **AI assistance**: both checkboxes present, **exactly one** checked. If "I
   used AI assistance" is the one, there must be a non-empty description below
   the checkboxes (tool, what it did, how you verified).
10. **Checklist**: all seven checkboxes present and **all checked** — check them
    honestly, which means the repo gates below actually ran.

## The flow

```bash
# 1. Gates the checklist asserts (run what your diff touches):
pnpm --filter <pkg> build && pnpm --filter <pkg> test
pnpm terminology:check        # any visible Studio copy ("agent", never "workflow")
pnpm provider-copy:check      # provider-neutral copy surfaces
# UI change → the Playwright suite: pnpm --filter @sapiom/harness test:ui
# published-package change → add .changeset/<slug>.md

# 2. Write the body to a file (never inline — backticks and quoting will bite):
$EDITOR /tmp/pr-body.md       # start from .github/pull_request_template.md

# 3. Validate locally with the repo's OWN classifier before GitHub sees it:
node -e "
import('./scripts/pr-label-classifier.mjs').then(async (m) => {
  const fs = await import('node:fs');
  const r = m.validatePullRequestTemplate(fs.readFileSync('/tmp/pr-body.md','utf8'));
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.complete ? 0 : 1;
});"
# → must print "complete": true with empty "reasons" (each reason names the fix)

# 4. Open (or repair) the PR:
gh pr create --base main --title "type(scope): imperative summary" --body-file /tmp/pr-body.md
gh pr edit <num> --body-file /tmp/pr-body.md    # fixing a flagged PR — labeler re-runs on edit
```

## Reading the labels it applies

| Label | Meaning | Act? |
| --- | --- | --- |
| `contribution: incomplete` | body fails the template contract | **Yes** — fix the body (workflow logs list each reason) |
| `size: small/medium/large/xlarge` | changed lines, lockfiles/generated excluded | No — informational |
| `review: sensitive` | touches `.github/`, `.claude/`, workflows, scripts, auth/security paths | No — expect closer review |
| `review: manual` / `needs-triage` / `contributor: external` | routing for maintainers | No |
| `area: *` / type label (`enhancement`, `bug`, …) | from `.github/labeler.yml` + the primary-type checkbox | No |

## Gotchas that have actually flagged PRs

- A beautiful free-form body (`## What` / `## Testing`) is still incomplete —
  the section headings are matched by name, not by spirit.
- Don't reword the checkbox lines: matching is by lowercase **prefix** ("i read
  \`contributing.md\`", "i have not included secrets", …) and every expected box
  must appear exactly once.
- Leaving the Validation placeholder block untouched reads as empty.
- `Changeset: N/A` without a reason fails; `N/A — docs only` passes.
- The title is NOT checked by the classifier, but follow the repo's
  conventional-commit style anyway (`feat(harness): …`) — it becomes the squash
  commit subject.
