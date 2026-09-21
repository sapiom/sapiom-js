import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { joinPath, parentOf, stripTrailingSep } from "./paths.js";

it.each(["/", "\\"])("bounds processing of repeated %s separators", (sep) => {
  const root = sep.repeat(64_000) + "leaf";
  const start = performance.now();
  const joined = joinPath(root, "child");
  const parent = parentOf(root);
  const trimmed = stripTrailingSep(root);
  const elapsed = performance.now() - start;
  expect(joined).toBe(root + sep + "child");
  expect(parent).toBe(sep.repeat(63_999));
  expect(trimmed).toBe(root);
  // Linear scans take milliseconds; leave ample headroom for loaded CI hosts.
  expect(elapsed).toBeLessThan(1_000);
});
