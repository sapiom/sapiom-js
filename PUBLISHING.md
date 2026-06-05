# Publishing

> **Scope:** Right now only **`@sapiom/sandbox`** is actively maintained and
> published. The other packages are not in use. This is a **temporary manual
> process** until we have a universal release fix.

## Why publishing is manual

The npm `@sapiom` org requires **two-factor auth to publish**, satisfied via an
interactive browser/security-key flow. CI (and `pnpm changeset publish` /
`pnpm release` run non-interactively) can't perform that flow, so automated
publish fails — historically with a confusing `403` or `404`. The `Publish`
GitHub workflow is therefore disabled (manual-dispatch only).

## Release steps

### 1. Bump the version (normal changeset flow)

In your change PR, add a changeset and merge it:

```bash
pnpm changeset        # pick @sapiom/sandbox + bump type, write summary
```

Merging to `main` opens a **"chore: version packages"** PR that bumps
`package.json` + updates the changelog. **Merge that PR** so `main` has the new
version.

### 2. Publish manually

⚠️ Do **not** use a bare `npm publish` from the package dir — npm won't rewrite
the `workspace:*` dependency and you'll ship a broken, uninstallable package
(this is what happened to `0.8.1`). Use `pnpm pack` to produce a tarball with
the workspace protocol resolved, then publish that tarball interactively with
npm so the 2FA browser/security-key prompt works:

```bash
git checkout main && git pull              # be on the merged version bump
cd packages/sandbox
pnpm pack                                  # rewrites workspace:* -> real version
npm publish sapiom-sandbox-<version>.tgz --access public
# ^ opens a browser link for 2FA — approve with your security key
```

### 3. Verify

```bash
npm view @sapiom/sandbox@<version> dependencies   # @sapiom/fetch should be a real version, NOT workspace:*
npm view @sapiom/sandbox dist-tags                # latest -> <version>
```

A clean install is the ultimate check:

```bash
npm install @sapiom/sandbox@<version>   # must resolve with no EUNSUPPORTEDPROTOCOL error
```

### 4. If a broken version slipped out

npm versions are immutable and unpublishing locks the number for 24h, so the fix
is to publish the next patch (correctly) and deprecate the bad one:

```bash
npm deprecate @sapiom/sandbox@<bad-version> "Broken: unresolved workspace dependency. Use <good-version>+"
```

## Reviving automated publishing (future)

Re-enable the `Publish` workflow's `push` trigger and replace the `NPM_TOKEN`
secret with a **granular access token that has "Bypass two-factor
authentication" enabled**, scoped to `@sapiom` read+write. With that token,
`pnpm changeset publish` runs non-interactively and the manual steps above
become unnecessary.
