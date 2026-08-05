import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { verifyUpdateManifests } from "./verify-update-manifests.mjs";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function fixture(manifestArtifact, uploadedArtifact) {
  const root = mkdtempSync(join(tmpdir(), "sapiom-update-manifest-"));
  fixtures.push(root);
  const platform = join(root, "windows");
  mkdirSync(platform);
  writeFileSync(
    join(platform, "latest.yml"),
    `files:\n  - url: ${manifestArtifact}\n`,
  );
  writeFileSync(join(platform, uploadedArtifact), "fixture");
  return root;
}

test("accepts a manifest whose URL exactly matches an uploaded artifact", () => {
  const root = fixture("Sapiom-Setup-0.2.0.exe", "Sapiom-Setup-0.2.0.exe");

  assert.deepEqual(verifyUpdateManifests(root, "latest"), {
    manifests: 1,
    references: 1,
  });
});

test("rejects the Windows updater hyphen-versus-dot mismatch", () => {
  const root = fixture("Sapiom-Setup-0.1.5.exe", "Sapiom.Setup.0.1.5.exe");

  assert.throws(
    () => verifyUpdateManifests(root, "latest"),
    /latest\.yml references 'Sapiom-Setup-0\.1\.5\.exe'.*404/,
  );
});
