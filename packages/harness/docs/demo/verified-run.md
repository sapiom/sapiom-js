# AGENT-289 — verified demo run (2026-09-02)

Everything below was executed against the local stack and read back from the DB,
the GCS emulator, and the web UI. No step is asserted from design docs.

Tenant `977b0556-f0d8-4ac5-818d-e1f27af69f36` · bucket `sapiom-sources-local` ·
engine allowlist scoped to that one tenant.

## Scene 1 — an existing agent, the old way (agent 41 `hello-demo`)

Engine in **git mode** (`WORKFLOWS_SOURCE_ARCHIVE_ENABLED` off).

| what | value |
|---|---|
| repository row | `ag-ebc29454-266a-4446-8c70-f76305085eb9` (provider `local_vcs`) |
| push credentials minted | 1 |
| pushes recorded | 1 |
| build | 52, `ready`, transport **git** |
| run output | `{"version":"0.0.1","greeting":"Hello, Antoine!"}` |

Web UI, Versions tab, after tagging `0.0.1`:

    35c7a22  [latest] [0.0.1]  3m ago  Sapiom Deploy  deploy  1  100%  —  Current

The tag chips are the AGENT-289 frontend change rendering against the real backend.

## Scene 2 — same agent, the new way (build 53)

Engine flipped to **archive mode** for this tenant only.

| what | value |
|---|---|
| build | 53, `ready`, transport **gcs** |
| digest at enqueue | `7a9e3b7dece9` |
| `source_archives` row | def 41, 778 bytes |
| GCS object | `977b0556…/sources/41/7a9e3b7dece9….tar.gz`, 778 bytes |
| run output | `{"shouted":true,"version":"0.0.2","greeting":"BONJOUR, ANTOINE !"}` |

Both protocols now coexist on one agent:

    build 52  35c7a22bb174  git   (no digest)
    build 53  7a9e3b7dece9  gcs   7a9e3b7dece9

`commit_sha` is a general version key: a git SHA on one row, a content digest on
the other. Nothing had to be migrated for the two to sit side by side.

## Scene 3 — rollback

`0.0.1` re-activated. Run went back to `{"version":"0.0.1","greeting":"Hello, Antoine!"}`
on build 52 — i.e. it re-served the **git** version while the newest build is an
archive. The UI shows:

    banner: Pinned to 35c7a22 — later deploys won't go live until you activate
            another version or resume following latest.   [Resume following latest]

    7a9e3b7  [latest] [0.0.2]  —              —       1  100%  View
    35c7a22           [0.0.1]  Sapiom Deploy  deploy  2  100%  Current · Pinned

`latest` stayed on the newest build while `Current` moved down — the two concepts
are separate, and `latest` is computed, never stored.

Note the archive row's Author/Change are `—`: no git commit means no author and no
commit message. That difference is visible in the UI and is expected.

## Scene 4 — a brand-new agent gets no git at all (agent 42 `fresh-demo`)

Created and deployed with the flag on:

| id | agent | repository | credentials ever minted |
|---|---|---|---|
| 41 | hello-demo | `ag-ebc29454-…` | 2 |
| 42 | fresh-demo | **(none)** | **0** |

Build 54, `ready`, transport `gcs`, digest `c1c11736f4cf`. No repository row before
or after the deploy — `ensureRepoForDefinition` is never reached.

## Scene 5 — the source comes back down without git

    GET /v1/workflows/definitions/42/source
    → HTTP 200, 878 bytes, content-type: application/gzip
      x-sapiom-source-digest: c1c11736f4cfd0f712761818d137a021…

    sha256(downloaded bytes) == source_archives.digest == GCS object name
    contents: index.ts, package.json

Content-addressing verified end to end: the bytes you get back hash to the name
they were stored under.

## Two defects found and fixed during this run

Both were in the frontend, both surfaced only because an agent can now
legitimately have no repo.

1. `agents/[id]/layout.tsx` — the header subline concatenated
   `{repoName}{' · ' + sha7}`, so an archive-backed agent rendered a dangling
   `· c1c1173` with nothing before it. **Ships to production.** Now joined and
   filtered. The existing test encoded the bug: it asserted a literal `· ` prefix
   against a `repoName: null` fixture, so it never exercised the two-part case it
   was named for. Split into both cases.

2. `agents/_lib/github-source.ts` — the dev branch built the local git URL from
   tenant + slug and ignored `repoName`, minting a plausible link to a repo that
   was never created. Dev-only (the prod branch already returned `null`
   correctly), but it renders during this demo. Now guarded, and the empty state
   explains the real reason instead of claiming "tenant not resolved".

87 frontend tests pass across the three affected files.

## Not verified

Clicking the rollback control in the UI. My browser automation could navigate and
read the page but its clicks did not reach React's handlers, so I exercised
activation through the API instead and confirmed the UI reflected it. The control
is wired at `VersionsPanel.tsx:285` (row toggle) → expansion → confirm dialog →
`activate.mutate(sha)`; worth one manual click before presenting.
