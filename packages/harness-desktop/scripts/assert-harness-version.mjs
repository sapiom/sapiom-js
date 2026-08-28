import { createRequire } from "node:module";

import { assertHarnessVersion } from "./harness-version.mjs";

const require = createRequire(import.meta.url);
const manifestPath =
  process.argv[2] ?? require.resolve("@sapiom/harness/package.json");

assertHarnessVersion(manifestPath, "desktop development dependency");
