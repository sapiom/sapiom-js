---
name: release-desktop
description: How to cut a Sapiom Studio desktop release (@sapiom/harness-desktop) in this repo. The release is TRIGGERED BY PUSHING A GIT TAG on main — `harness-desktop-vX.Y.Z` — after versions are bumped via changesets. Use whenever asked to "release", "cut/make a release", "ship a new version", "publish/tag the desktop app", "do a release", or asked whether something "is ready to release / version bumped".
---

# Releasing the Sapiom Studio desktop app

The desktop app ships as **signed installers** (dmg/zip on macOS, AppImage/deb on
Linux, nsis on Windows), NOT to npm. A release is cut by **pushing a git tag on
`main`**; version bumping is handled by **changesets** first.

## The invariant that governs everything
The tag **must equal** `packages/harness-desktop/package.json`'s `version`
exactly (e.g. tag `harness-desktop-v0.2.4` ⇔ version `0.2.4`). The
`desktop-release.yml` `prepare` job fails fast on a mismatch. `package.json` — not
the tag — is the source of truth for the artifact names and the app's self-reported
version and update channel.

## Tag conventions (drive the update channel)
| Tag | Release | Channel |
| --- | --- | --- |
| `harness-desktop-v1.2.3` | final | `latest` (everyone) |
| `harness-desktop-v1.2.3-beta.1` | pre-release | `beta` (opted-in only) |

`workflow_dispatch` (manual run of desktop-release.yml) builds artifacts only — no
tag, no publish. Useful to smoke a build without releasing.

## The full flow

1. **Every fix/feature PR carries a changeset.** `.changeset/<name>.md` with the
   bumped package(s) and a summary. Format:
   ```md
   ---
   "@sapiom/harness-desktop": patch
   "@sapiom/harness": patch
   ---

   One-paragraph, user-facing description of the change.
   ```
   - A change only in `@sapiom/harness` needs only that entry — `harness-desktop`
     gets a **patch** bump automatically (changeset config
     `updateInternalDependencies: "patch"`, since it depends on
     `@sapiom/harness` via `workspace:^`). But if you want the desktop CHANGELOG
     to *describe* a desktop-side fix, add an explicit `@sapiom/harness-desktop`
     entry too.
   - **If a PR merged without a changeset, its fix ships silently** (no changelog
     entry). Add the missing changeset before releasing — a later PR's changeset
     file is fine; changesets are just release-note artifacts on `main`.
   - Check coverage: `ls .changeset/*.md` (ignore README.md) and read each header.

2. **Merge the PRs to `main`.** Changesets accumulate on `main`.

3. **The version-PR is automatic.** `.github/workflows/release-pr.yml`
   (changesets/action@v1, on push to `main`) opens/updates a
   **"chore: version packages"** PR that runs `pnpm run version-packages`
   (= `changeset version` + regenerate the version fallback + `pnpm install
   --lockfile-only`). That PR **consumes the changesets**, bumps every affected
   `package.json`, and writes the `CHANGELOG.md`s.
   - You normally do NOT run `changeset version` by hand — let the PR do it. (If
     you must locally: `pnpm run version-packages`.)

4. **Merge the "chore: version packages" PR.** Now `main` has the bumped
   `packages/harness-desktop/package.json` version + changelogs. Note the new
   version, e.g. `0.2.4`.

5. **Tag and push on `main`** (this is the actual release trigger):
   ```bash
   git checkout main && git pull
   v=$(node -p "require('./packages/harness-desktop/package.json').version")   # e.g. 0.2.4
   git tag "harness-desktop-v$v"          # add a -beta.N suffix for a beta
   git push origin "harness-desktop-v$v"
   ```
   This starts `desktop-release.yml`: `prepare` (version/channel + tag match) →
   one build job per OS (sign + notarize on macOS) → uploads the installers +
   `latest*.yml`/`*.blockmap` update metadata to the GitHub Release.

6. **Watch it.** macOS notarization can take ~35 min (job cap is 75). Don't kill a
   build that looks stuck in signing — read the diagnostic first (see
   `packages/harness-desktop/CLAUDE.md` → macOS).

## Answering "is the version bumped / ready to release?"
- Current version: `node -p "require('./packages/harness-desktop/package.json').version"`.
- Existing tags: `git tag --list 'harness-desktop-v*' | tail`.
- Pending changesets (what the NEXT bump will include): `ls .changeset/*.md`.
- If `package.json` still equals the latest tag, the version is **not yet bumped** —
  the "chore: version packages" PR (step 3–4) must merge before you can tag.

## Related, don't confuse
- `publish.yml` publishes the **npm** packages (`@sapiom/harness`, `@sapiom/tools`,
  …) on version bump — separate from the desktop installer release.
- Full desktop packaging/signing gotchas live in
  `packages/harness-desktop/CLAUDE.md` (asar, node-pty rebuild, mac signing secrets,
  the `--smoke` gate). Read it before touching the build itself.
