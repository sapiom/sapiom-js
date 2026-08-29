/**
 * The release TAG is load-bearing for the pre-release channel, and every way of
 * breaking it is silent: the build goes green, the release publishes with correct
 * assets, and the artifact is simply invisible to the installs that asked for it.
 *
 * That is not hypothetical. `harness-desktop-v0.3.8-beta.1` was cut, built, and
 * published with correct `beta*.yml` assets — and no install could ever receive
 * it, because electron-updater's `GitHubProvider.getLatestVersion()` runs
 * `semver.valid(tag)` over every `releases.atom` entry when resolving a
 * pre-release channel and SKIPS the ones that fail:
 *
 *     const hrefTag = hrefElement[1];        // "harness-desktop-v0.3.8-beta.1"
 *     if (!semver.valid(hrefTag)) continue;  // → null, so every entry is skipped
 *     ...
 *     if (tag == null) throw newError(`No published versions on GitHub`, ...)
 *
 * A leading `v` is the only prefix semver tolerates, so the tag namespace has to
 * be `v<version>`. The stable channel never noticed because it takes a different
 * branch entirely (`getLatestTagName()` → `/releases/latest`), which treats the
 * tag as an opaque string — which is exactly why this survived from the first
 * release to 0.3.8 with every test green. See SAP-2965.
 *
 * Text assertions over the workflow file, deliberately: this package's vitest run
 * never imports `electron` or `electron-updater` (see vitest.config.ts), and a
 * pure unit test of `update-policy.ts` structurally CANNOT catch this — the bug
 * lives at the provider boundary those tests don't reach. The workflow's own
 * semver guard in `prepare` is the other half: this file stops the namespace
 * regressing, that step stops a non-semver *version* shipping.
 *
 * The mirror-step assertion below guards the opposite mistake. It looks like dead
 * weight next to electron-builder's `generateUpdatesFilesForAllChannels`, but
 * that option is a NO-OP for us — `computeChannelNames()` short-circuits on
 * `publishConfig.provider === "github"` and returns a single channel. Deleting
 * the mirror would strand every beta install on the beta line with no path back
 * to stable, and nothing else in CI would notice.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../../../.github/workflows/desktop-release.yml", import.meta.url),
  "utf8",
);

/**
 * Whether `v${version}` is a tag electron-updater's pre-release resolution will
 * accept — i.e. whether `semver.valid()` returns non-null for it.
 *
 * Hand-rolled rather than importing `semver`, for the same reason
 * `update-policy.ts` hand-rolls its pre-release check: semver is not a declared
 * dependency of this package, only a transitive one of electron-updater, and
 * leaning on a transitive dep is how a working build breaks on an unrelated
 * upgrade.
 */
function isSemverParseableTag(tag: string): boolean {
  return /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(tag);
}

describe("desktop release tag namespace", () => {
  it("triggers on `v*`, so published tags are semver-parseable", () => {
    expect(workflow).toMatch(/tags:\s*(?:#[^\n]*\n\s*)*(?:#[^\n]*\n\s*)*-\s*"v\*"/);
  });

  it("no longer triggers on the un-parseable `harness-desktop-v*` namespace", () => {
    // Prose mentioning the old namespace is fine and expected (the comments
    // explain the migration); an actual trigger entry is not.
    expect(workflow).not.toMatch(/^\s*-\s*"harness-desktop-v\*"\s*$/m);
  });

  it("guards that the tag equals `v${version}` from package.json", () => {
    expect(workflow).toContain('expected="v${version}"');
  });

  it("fails the build outright on a version that isn't semver", () => {
    // The cheap CI half of this file's contract. Without it, a hand-edited
    // version on a release branch republishes the original bug.
    expect(workflow).toMatch(/is not valid semver/);
  });

  it("still mirrors stable manifests onto the beta channel", () => {
    // NOT redundant with generateUpdatesFilesForAllChannels — see the file
    // header. Removing this silently strands beta installs.
    expect(workflow).toContain("Mirror stable manifests onto the beta channel");
    expect(workflow).toMatch(/beta\$\{base#latest\}/);
  });
});

describe("isSemverParseableTag", () => {
  it("accepts the tags the new namespace produces", () => {
    for (const version of ["0.3.9", "0.3.9-beta.1", "1.0.0", "0.3.9-beta.10", "0.3.9+ci.44"]) {
      expect(isSemverParseableTag(`v${version}`)).toBe(true);
    }
  });

  it("rejects every tag the old namespace produced — final and pre-release alike", () => {
    // The second case is the trap: cutting a "proper" beta under the old prefix
    // failed identically to a final, which is why the namespace (not the version
    // suffix) is the actual fix.
    expect(isSemverParseableTag("harness-desktop-v0.3.8")).toBe(false);
    expect(isSemverParseableTag("harness-desktop-v0.3.8-beta.1")).toBe(false);
  });
});
