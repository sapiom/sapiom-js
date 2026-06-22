# Publishing

Publishing is **automated**. The `Publish` workflow
(`.github/workflows/publish.yml`) runs on every push to `main` and publishes to
npm via **OIDC Trusted Publishing** — no long-lived `NPM_TOKEN`, no interactive
2FA in CI. You normally never run a publish command by hand.

The one exception is the **first-ever publish of a brand-new package**, which
CI cannot do (see [Bootstrapping a new package](#bootstrapping-a-new-package)).

> The `@sapiom/langchain` and `@sapiom/langchain-classic` packages are
> quarantined out of the workspace (see `pnpm-workspace.yaml`) and are not
> published by this flow.

## The normal flow (automated)

1. **In your change PR, add a changeset** describing the bump:
   ```bash
   pnpm changeset        # pick package(s) + bump type, write summary
   ```
   Commit it and merge the PR.
2. Merging to `main` makes the `Release PR` workflow open (or update) a
   **"chore: version packages"** PR that applies the changeset: bumps
   `package.json` versions, updates `CHANGELOG.md`, and deletes the changeset
   file.
3. **Merge that "version packages" PR.** The push to `main` triggers the
   `Publish` workflow, which runs `pnpm changeset publish`. Because it goes
   through pnpm it resolves `workspace:*` to real version ranges, and it only
   publishes versions not already on npm — so it's a safe no-op on any push that
   isn't a version bump.

That's it. npm generates provenance attestations automatically under trusted
publishing.

### Prerequisites (already configured; here for reference)

- **A Trusted Publisher configured PER PACKAGE on npmjs.com**, pointing at repo
  `sapiom/sapiom-js` and workflow file `publish.yml` (environment left blank). A
  missing or mismatched trusted publisher is the usual cause of a publish
  **E404** — and the reason a brand-new package needs a manual first publish.
- Toolchain in the workflow: Node 24 and npm >= 11.5 (OIDC support) + pnpm 10+.
  `packageManager` in the root `package.json` must stay in sync.
- The job grants `id-token: write` so the runner can mint the short-lived OIDC
  token npm trades for publish auth.

## Bootstrapping a new package

OIDC trusted publishing has a catch-22: you can't configure a trusted publisher
for a package until the package exists on npm, but CI can only publish packages
that already have one. So the **first** publish of a new package is manual;
every publish after that is automated.

Symptom you'll see if you skip this: the `Publish` job fails on the new package
with an **E404**, *after* successfully publishing the already-configured ones
(so the run is red but partially published).

### 1. Make sure the version-bump flow has run

The new package should already be versioned on `main` (its changeset merged and
the "version packages" PR merged), so its `package.json` has the version you
want to ship and `dist/` is buildable. Be on the merged commit:

```bash
git checkout main && git pull
pnpm install --frozen-lockfile
pnpm build
```

### 2. Pack with pnpm, then publish the tarball

**Always pack with `pnpm`** — it rewrites `workspace:*` deps to real version
ranges in the tarball. A bare `npm publish` from source does **not**, and ships
an uninstallable package (this is what broke `@sapiom/sandbox@0.8.1`).

```bash
cd packages/<new-package>
pnpm pack                         # produces sapiom-<name>-<version>.tgz with deps resolved
npm publish sapiom-<name>-<version>.tgz --access public
```

Publish in **dependency order** if several new packages depend on each other
(a dependency must be on npm before the package that needs it is installable).

#### Authenticating the manual publish

The `@sapiom` org requires 2FA to publish. Pick whichever you have:

- **Security key only (no authenticator app):** run `npm publish` **without**
  `--otp`. npm prints a browser link (`Authenticate your account at: …`);
  open it and approve with your security key. The `--otp=` flag does **not**
  apply — you have no way to type a TOTP code.
- **TOTP authenticator app (Authy/1Password/etc.):** pass a fresh 6-digit code
  with `--otp=<code>` (they rotate ~30s; if it expires, npm re-prompts).

> A successful publish prints `+ @sapiom/<name>@<version>`. In the npm debug log
> the authoritative signal is `http fetch PUT 200 …/@sapiom%2f<name>`. A
> brand-new package can take **several minutes** to become readable on the
> public registry (`npm view` / a registry GET returns 404 in the meantime) even
> though the `PUT 200` means it's committed — that read lag is normal and not a
> failure.

### 3. Configure the Trusted Publisher (so CI takes over)

Now that the package exists, on npmjs.com → the package → **Settings → Trusted
Publisher → Add**:

- Provider: **GitHub Actions**
- Repository: `sapiom/sapiom-js`
- Workflow filename: `publish.yml`
- Environment: *(leave blank)*

From here on, the package publishes automatically via the normal flow.

### 4. Verify

```bash
npm view @sapiom/<name>@<version> dependencies   # @sapiom/* deps must be real ranges, NOT workspace:*
npm view @sapiom/<name> dist-tags                # latest -> <version>

# clean-room install (the real test — catches unresolved workspace deps):
mkdir /tmp/itest && cd /tmp/itest && npm init -y >/dev/null
npm install @sapiom/<name>@<version>             # must resolve with no EUNSUPPORTEDPROTOCOL / UNMET
```

## If a broken version slipped out

npm versions are immutable and unpublishing locks the number for 24h, so the fix
is to publish the next patch correctly and deprecate the bad one:

```bash
npm deprecate @sapiom/<name>@<bad-version> "Broken: unresolved workspace dependency. Use <good-version>+"
```

## Manually re-running the Publish workflow

Safe at any time — `changeset publish` only ships versions not already on npm,
so a re-run is a no-op for everything currently published:

```bash
gh workflow run publish.yml --ref main
```
