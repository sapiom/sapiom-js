# Native context assessment fixture

This opt-in probe supplies the native evidence for [SAP-3399](https://linear.app/sapiom/issue/SAP-3399).
It starts the real pinned OpenCode binary in temporary state, drives harmless tools against fixture files/MCP,
and captures actual Responses request bodies and native history. Its local provider returns synthetic usage;
those numbers are **not cache measurements**. No account credentials are required.

## Run

From an installed SDK checkout, with Node 20+ and the pinned pnpm:

```sh
pnpm install --frozen-lockfile
pnpm --filter @sapiom/opencode build
node --test scripts/assistant-context-projection.test.mjs
packages/harness/node_modules/.bin/tsx scripts/assistant-context-probe.mjs . /tmp/context-probe.json
```

If install scripts were disabled, first run `node packages/opencode/node_modules/opencode-ai/postinstall.mjs`
to materialize the pinned platform executable. The package's placeholder executable cannot run this probe.
The output path must be outside the temporary runtime; the script removes its fixture workspace on exit.

The first argument is the SDK checkout **under assessment**, which can differ from the checkout containing
these scripts. When that checkout contains `studio-assistant-context.ts`, the probe imports its actual
composer/recovery functions. Otherwise it constructs a clearly labeled fixture envelope for native-only
checks on main. Missing dependencies inside an existing composer are errors, not a fallback condition.

## Cases and limits

The probe checks root discovery and nested file-read discovery separately. During the first model call it
changes an explicit native instruction file and an already discovered skill body, then observes subsequent
native tool steps. It changes nested rules before another read and changes Studio guidance/selection before
a new user turn. It also exercises recovery, native summarization with synthetic continuation, restart with
the same state, and an independent conversation in the same folder.

The projection experiment moves profile guidance before changing completion metadata in the privileged
system/developer request. It preserves old saved system records, the new saved v2 envelope, completion-token
validation, and native continuation. The small helper recognizes this controlled envelope; downstream
production integration must use validated host context and the full source/lifecycle contract.

The host overwrites arbitrary `config.plugin` entries. The fixture therefore composes its test hook into the
host-generated credential-isolation plugin via `beforeLaunch`, preserving its existing hooks. Native
`experimental.chat.system.transform` requires mutating the original array with `splice`; assigning a new
`output.system` array was tested and left the wire layout unchanged. This fixture does not install a product hook.

Current-runtime expectations include behaviors that downstream implementation must correct: explicit
instructions are reread during a turn, while nested instructions can load despite disabled project discovery.
Update those expectations deliberately when changing the runtime; an upgraded pin needs fresh evidence.

## Assessment candidate, 2026-09-12

The issue's evidence bundle records source provenance, requests, history, and exact checksums. The candidate
combines these SDK revisions in a disposable integration checkout:

| Input                     | Commit                                     |
| ------------------------- | ------------------------------------------ |
| main                      | `76318848fd270bfc179315e99b7e2cce4049a5b1` |
| #950 response visibility  | `9b40f11351bc86190482add78d16092ff31ce4c4` |
| #951 Luna Responses route | `eff8fe067eec145a8db1043859a66900907c2a3b` |
| #952 context types        | `963bb6b0cf5b4d772d7f3503b7f93fa3fea4994d` |
| #953 context delivery     | `7c8eb92aaaa4a8aa495605367d7d6f7c41ce44c3` |
| Local integration commit  | `7e83d40321e8a4ce21cff8a3eff1c43bf4bbc345` |
| Integration tree          | `50d84dde1805a8e4006431f587eeffb2b566c5d0` |

Runtime: OpenCode **1.18.29**, upstream commit `16747470f976aca3d362ad730bcd3fe82ecc2c9a`;
Assistant UI adapter **0.2.22**. The native fixture explicitly selects the OpenAI Responses provider and
`gpt-luna`, including when its SDK input is pre-Luna main.

To reconstruct the integration tree, fetch the pinned #953 revision into a fresh detached checkout and apply
the issue bundle's `candidate.patch` with `git apply --index candidate.patch`. `git write-tree` must equal the
tree above. That patch incorporates #950/#951; overlapping normal/recovery requests retain #953 context
admission and #951's `model: hosted.model`. The README retains both changes. The integration commits are
assessment inputs, not changes delivered by this test PR.

Install/build dependencies in that checkout, then pass its absolute path to this probe. The gateway probe
in the next assessment PR additionally needs built MCP/workspace dependencies and the Luna/context candidate.
The issue carries the complete lifecycle contract and actual gateway baseline; this fixture alone does not
certify queued dispatch, live skill/MCP refresh, browser sign-in, or all Studio session controls.
