# SAP-4112: route the harness tenant key through credentialFetch

## Goal

Every place `packages/harness` puts the Sapiom tenant key on a request (or into a config another process sends) goes
through the shared channel policy of `@sapiom/analytics-core/credential`, and `scripts/credential-header-allowlist.json`
becomes `[]`. After this PR, the only code in `packages/*/src` that writes a tenant-key header is
`packages/analytics-core/src/credential.ts`.

## Approach

Reuse `credentialFetch` as is for the eight network sites; extend it by the smallest amount for the two things it
cannot do today:

1. **Bearer sites.** `Credential.header` only accepts `"x-api-key" | "x-sapiom-api-key"`
   (`packages/analytics-core/src/credential.ts:295-298`). Add `"authorization"` to the union. The rest already works for
   it: the caller's own `Authorization` is replaced case-insensitively (`credential.ts:314`), and a cross-origin hop
   drops `authorization` (`credential.ts:80-86`, `287-289`). The four core-surface sites then pass
   `{ header: "authorization", value: \`Bearer ${key}\` }`. One route for all ten sites, no second "equivalent check".
2. **MCP config file.** The key is not sent by harness but written into `mcp-config.json` for Claude Code / Codex.
   Add one helper next to `credentialFetch`: `credentialHeaders(url, credential, policy)` runs
   `assertCredentialMayTravel(new URL(url), policy)` and returns `{ [credential.header]: credential.value }`.
   `generateMcpConfig` calls it at the line where it chooses `remoteMcpUrl` (`mcp-config.ts:88-96`). The Codex adapter
   reads URL and headers from that same file (`core/adapters/codex-mcp.ts:88-120`), so one check covers both harnesses.

Harness policy: one function `harnessCredentialPolicy()` =
`resolveCredentialPolicy(undefined, { label: "@sapiom/harness" })`, called per request (same as `@sapiom/mcp`,
`app-links-api.ts:103`) so `SAPIOM_ALLOW_INSECURE_HTTP` is read when the request is made. The opt-in is that env var,
which the refusal message already names (`credential.ts:71-76`). No harness CLI flag or desktop option.

Refusal behaviour: `credentialFetch` throws `CredentialChannelError` (a `TypeError`) before any byte is sent. Every
network site already wraps its fetch in a `try/catch` that maps a throw to its existing failure result (502
"gateway unreachable", "unavailable", `null`, Studio "Assistant connection failed"), so no new error plumbing.
`generateMcpConfig` lets the error propagate: session start fails with the refusal message, which names the opt-in.

## Tasks

### T1. analytics-core: Bearer credential and config-file headers

Files: `packages/analytics-core/src/credential.ts`, `packages/analytics-core/src/credential.spec.ts`

Steps:
- `Credential.header`: add `"authorization"`.
- Add `export function credentialHeaders(url: string, credential: Credential, policy: CredentialPolicy): Record<string, string>`
  (assert, then return the one header). Doc comment: for a key handed to another process, checked where the URL is
  chosen.
- Module comment line 2: drop the "Harness exceptions ... SAP-4112" sentence.
- Specs: an `authorization` credential replaces a caller `Authorization` header and is dropped on a cross-origin
  redirect, kept on a same-origin one; `credentialHeaders` returns the header for https and loopback http, throws
  `CredentialChannelError` for non-loopback http and for a non-http scheme, and honours `allowInsecureHttp`.

### T2. harness: shared policy

Files: `packages/harness/src/core/credential-policy.ts` (new, ~5 lines)

Steps:
- `export function harnessCredentialPolicy(): CredentialPolicy` as above.

### T3. harness: agents-surface sites (`x-sapiom-api-key`)

Files: `packages/harness/src/core/run-state.ts`, `packages/harness/src/core/definition-slug-resolver.ts`,
their `.test.ts`

Steps:
- `run-state.ts:102-105`: `credentialFetch(fetchImpl, url, {}, { header: "x-sapiom-api-key", value: apiKey }, harnessCredentialPolicy())`.
- `definition-slug-resolver.ts:186-192` and `254-257`: same, keeping `signal: AbortSignal.timeout(5_000)` in `init`.
- Tests: exact-argument assertions become `expect.objectContaining({ headers: { "x-sapiom-api-key": ... } })`
  (credentialFetch adds `redirect: "manual"`, `method`, `body`). Add one test per file: base URL
  `http://agents.internal` makes no fetch call and returns the existing failure result; with
  `SAPIOM_ALLOW_INSECURE_HTTP=1` the call is made.

### T4. harness: core-surface Bearer sites

Files: `packages/harness/src/core/vault-secrets.ts`, `account-plan.ts`, `template-catalog.ts`,
`definition-app-link.ts`, their `.test.ts`

Steps:
- Each `fetchImpl(url, { ...init, headers: { ..., Authorization: \`Bearer ${key}\` } })` becomes
  `credentialFetch(fetchImpl, url, init, { header: "authorization", value: \`Bearer ${key}\` }, harnessCredentialPolicy())`
  (`vault-secrets.ts:92-99`, `account-plan.ts:134-137`, `template-catalog.ts:348-352`, `definition-app-link.ts:89-93`).
  Keep `signal` and the other init fields.
- Tests: header assertions read `authorization` (lowercase: credentialFetch writes the credential name as given), or
  `new Headers(init.headers).get("Authorization")` where the test already uses `Headers`. Add one refusal test per
  file (non-loopback http base URL: no fetch call, existing failure result).

### T5. harness: OpenCode bridge

Files: `packages/harness/src/server/opencode-bridge.ts`, `opencode-bridge.test.ts`

Steps:
- Drop `"x-api-key": key` from the `Headers` built at `opencode-bridge.ts:298-303`; the `request` thunk
  (`343-350`) calls `credentialFetch(fetch, upstream.href, { method, headers, body, redirect: "error", signal }, { header: "x-api-key", value: key }, harnessCredentialPolicy())`.
  `redirect: "error"` keeps plain-fetch redirect semantics (`credential.ts:230-232`); `assistantUpstreams` keeps its
  stricter https-or-loopback check (`129-162`).
- Existing tests already prove the upstream receives `x-api-key: sk_private_studio` and a caller `x-api-key` is
  ignored (`opencode-bridge.test.ts:288-306`, `364`, `401`); they must stay green unchanged.

### T6. harness: MCP config

Files: `packages/harness/src/core/inject/mcp-config.ts`, `mcp-config.test.ts`

Steps:
- `headers: credentialHeaders(remoteMcpUrl, { header: "x-api-key", value: options.apiKey }, harnessCredentialPolicy())`
  when `options.apiKey` is set; unchanged when absent.
- Tests: existing https case unchanged; a credentials file env with `apiURL: "http://10.0.0.5:3000"` and an apiKey
  rejects with `CredentialChannelError` and writes no file; same env without apiKey still writes the config;
  `apiURL: "http://localhost:3000"` writes the header; `SAPIOM_ALLOW_INSECURE_HTTP=1` lets the LAN URL through.

### T7. Allowlist, comments, changeset

Files: `scripts/credential-header-allowlist.json`, `packages/analytics-core/src/credential.ts` (comment, T1),
`.changeset/harness-credential-fetch.md` (new)

Steps:
- Allowlist file becomes `[]` (keep the file and the mechanism: the check reads it).
- Changeset: `@sapiom/harness: minor` (plain http to a non-loopback Sapiom host is now refused, opt in with
  `SAPIOM_ALLOW_INSECURE_HTTP=1`), `@sapiom/analytics-core: minor` (`"authorization"` credential,
  `credentialHeaders`). `harness-desktop` follows through `updateInternalDependencies: "patch"`.

## Testing Strategy

Order matters: harness resolves `@sapiom/analytics-core/credential` through its `dist` exports.

1. `pnpm --filter @sapiom/analytics-core exec jest --maxWorkers=2 src/credential.spec.ts`
2. `pnpm --filter @sapiom/analytics-core build`
3. `pnpm --filter @sapiom/harness exec vitest run --maxWorkers=2 src/core/run-state.test.ts src/core/definition-slug-resolver.test.ts src/core/vault-secrets.test.ts src/core/account-plan.test.ts src/core/template-catalog.test.ts src/core/definition-app-link.test.ts src/server/opencode-bridge.test.ts src/core/inject/mcp-config.test.ts`
4. `pnpm credential-header:check` and `node --test scripts/credential-header-check.test.mjs` (its "passes on the
   repository" case now runs with an empty allowlist).
5. `pnpm --filter @sapiom/harness typecheck` and `pnpm --filter @sapiom/analytics-core typecheck` if present, else `build`.

## Risks

- A user with a custom `~/.sapiom/credentials.json` environment on plain http to a non-loopback host (Docker service
  name, LAN IP) loses Studio sessions at start (MCP config refusal) and sees the core/agents panels as unavailable,
  until they set `SAPIOM_ALLOW_INSECURE_HTTP=1`. Built-in presets are https (`packages/mcp/src/credentials.ts:22-27`)
  and `localhost` keeps working, so default users see no change. Called out in the changeset.
- The agents/core panels report a refusal through their existing generic failure text ("gateway unreachable",
  "network error or timeout"); only account-plan and template-catalog log the refusal message itself. Acceptable
  because session start (T6) surfaces the actionable message first.
- Test churn: exact-argument fetch assertions in the eight harness test files need `objectContaining` or lowercase
  `authorization`.

## Open Questions

- Opt-in: is the env var enough, or does Studio need its own switch (CLI flag plus desktop option, both hosts)?
  This plan ships the env var only.
- MCP config refusal: fail session start (this plan) or write the config without the header (remote MCP tools then
  401)? Failing loudly names the fix; omitting keeps local tools usable.
