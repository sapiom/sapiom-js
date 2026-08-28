import { readFileSync } from "node:fs";

const desktopPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const workspaceHarnessPackage = JSON.parse(
  readFileSync(new URL("../../harness/package.json", import.meta.url), "utf8"),
);

const configuredVersion = desktopPackage.desktopHarnessVersion;

if (
  configuredVersion !== undefined &&
  (typeof configuredVersion !== "string" || configuredVersion.length === 0)
) {
  throw new Error(
    "harness-desktop desktopHarnessVersion must be a non-empty string when present",
  );
}

export const HAS_PINNED_HARNESS = configuredVersion !== undefined;
export const EXPECTED_HARNESS_VERSION =
  configuredVersion ?? workspaceHarnessPackage.version;

if (
  typeof EXPECTED_HARNESS_VERSION !== "string" ||
  EXPECTED_HARNESS_VERSION.length === 0
) {
  throw new Error("the workspace Harness package must declare a version");
}

export function assertHarnessVersion(manifestPath, context) {
  const { version: actualVersion } = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  );
  if (actualVersion !== EXPECTED_HARNESS_VERSION) {
    throw new Error(
      `${context} must use @sapiom/harness ${EXPECTED_HARNESS_VERSION}, resolved ${String(actualVersion)} at ${manifestPath}`,
    );
  }
  console.log(
    `[harness-version] ${context}: @sapiom/harness ${actualVersion} matches ${HAS_PINNED_HARNESS ? "desktopHarnessVersion" : "the workspace Harness"}`,
  );
  return actualVersion;
}
