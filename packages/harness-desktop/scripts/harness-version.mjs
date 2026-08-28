import { readFileSync } from "node:fs";

const desktopPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const EXPECTED_HARNESS_VERSION = desktopPackage.desktopHarnessVersion;

if (
  typeof EXPECTED_HARNESS_VERSION !== "string" ||
  EXPECTED_HARNESS_VERSION.length === 0
) {
  throw new Error(
    "harness-desktop package.json must declare desktopHarnessVersion",
  );
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
    `[harness-version] ${context}: @sapiom/harness ${actualVersion} matches desktopHarnessVersion`,
  );
  return actualVersion;
}
