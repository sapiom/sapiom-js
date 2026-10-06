import { createHash } from "node:crypto";

import { canonicalJson } from "./agent-map-canonical-pure.js";
export { canonicalJson, compareCanonicalStrings } from "./agent-map-canonical-pure.js";

export const canonicalDigest = (domain: string, value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
