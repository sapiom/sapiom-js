# Publishing

> **Scope:** Right now only **`@sapiom/sandbox`** is actively maintained and
> published. The other packages are not in use. This is a **temporary manual
> process** until we have a universal release fix (see
> [Reviving automation](#reviving-automated-publishing-future)).

## Why publishing is manual

The npm `@sapiom` org requires **two-factor auth to publish**. CI can't perform
2FA, so the `Publish` GitHub workflow is disabled (manual-dispatch only) and
releases are published from a maintainer's machine with a one-time password.

## One-time setup (per maintainer)

To publish you need **both** of these on your npm account
(npmjs.com → Account → Two-Factor Authentication):

1. A **TOTP authenticator app** enrolled (Authy, 1Password, Google
   Authenticator, …). A security key alone is **not** enough — it only works in
   the browser, and the publish flow needs a typed 6-digit code.
2. 2FA level set to **"Authorization and writes"** (not "Authorization only").

> Why both: `changeset publish` runs `npm profile get` and only asks for an OTP
> when `tfa.mode === "auth-and-writes"`. If it's "authorization only", it
> publishes **without** an OTP and npm rejects it with a confusing
> `404`/`E401` — this is the failure we chased down. Passing `--otp=` explicitly
> (below) sidesteps the detection entirely.

## Release steps

### 1. Bump the version (normal changeset flow)

In your change PR, add a changeset and merge it:

```bash
pnpm changeset        # pick @sapiom/sandbox + bump type, write summary
```

Merging to `main` opens a **"chore: version packages"** PR that bumps
`package.json` + updates the changelog. **Merge that PR** so `main` has the new
version.

### 2. Publish

```bash
git checkout main && git pull              # be on the merged version bump
pnpm install --frozen-lockfile
pnpm build
pnpm changeset publish --otp=<6-digit code>
```

`changeset publish` publishes via `pnpm`, so it **resolves `workspace:*`** to a
real version range, and only publishes packages whose version isn't already on
npm. The `--otp` code authenticates the publish — grab a **fresh** code right
before running (they rotate every ~30s); if it expires, changeset re-prompts.

> Running `pnpm release` (build + `changeset publish`) also works and will
> **interactively prompt** `Enter one-time password:` — but only if your 2FA
> level is "auth-and-writes". The explicit `--otp=` form above is the reliable
> one and doesn't depend on that detection.

### 3. Verify

```bash
npm view @sapiom/sandbox@<version> dependencies   # @sapiom/fetch must be a real version, NOT workspace:*
npm view @sapiom/sandbox dist-tags                # latest -> <version>
npm install @sapiom/sandbox@<version>             # clean install must resolve (no EUNSUPPORTEDPROTOCOL)
```

### 4. If a broken version slipped out

npm versions are immutable and unpublishing locks the number for 24h, so the fix
is to publish the next patch correctly and deprecate the bad one:

```bash
npm deprecate @sapiom/sandbox@<bad-version> "Broken: unresolved workspace dependency. Use <good-version>+"
```

## Fallback: publishing with only a security key

If you can't add an authenticator app and only have a security key, you can't
produce a typed OTP. Pack with pnpm (resolves `workspace:*`) and publish the
prebuilt tarball with an **interactive** `npm publish`, which opens the browser
2FA flow:

```bash
cd packages/sandbox
pnpm pack                                  # rewrites workspace:* -> real version
npm publish sapiom-sandbox-<version>.tgz --access public
# ^ opens a browser link for 2FA — approve with your security key
```

Never use a bare `npm publish` from source — npm won't rewrite `workspace:*` and
you'll ship a broken, uninstallable package (this is what happened to `0.8.1`).

## Reviving automated publishing (future)

Re-enable the `Publish` workflow's `push` trigger (currently `workflow_dispatch`
only) and give CI a credential that doesn't need interactive 2FA — either:

- a **granular access token with "Bypass two-factor authentication"** enabled,
  scoped to `@sapiom` read+write, stored as the `NPM_TOKEN` secret; or
- **OIDC trusted publishing** (no token): configure the package's trusted
  publisher on npmjs.com and publish from CI with a modern npm. The workflow
  already requests `id-token: write`.
