import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  audit,
  auditRepository,
  findCredentialHeaderSites,
} from "./credential-header-check.mjs";

describe("credential header guard", () => {
  for (const [label, line] of [
    ["an object key", `fetch(url, { headers: { "x-api-key": key } });`],
    ["a single-quoted object key", `const h = { 'X-Sapiom-Api-Key': k };`],
    ["a bracket assignment", `h["x-sapiom-api-key"] = k;`],
    ["setHeader", `client.setHeader("x-api-key", k);`],
    ["Headers.set", `headers.set('x-api-key', k);`],
    ["Headers.append", "headers.append(`x-sapiom-api-key`, k);"],
  ]) {
    it(`flags ${label}`, () => {
      assert.deepEqual(findCredentialHeaderSites(`ok\n${line}`), [2]);
    });
  }

  for (const [label, line] of [
    ["a header name as a value", `const opts = { authHeader: "x-api-key" };`],
    ["a type union", `type H = "x-api-key" | "x-sapiom-api-key";`],
    ["a Set entry", `const s = new Set(["x-api-key", "cookie"]);`],
    ["a comparison", `if (h["x-api-key"] === k) return;`],
    ["a credential passed by value", `{ header: "x-api-key", value: key }`],
  ]) {
    it(`does not flag ${label}`, () => {
      assert.deepEqual(findCredentialHeaderSites(line), []);
    });
  }

  it("exempts an allowlisted file and fails a stale entry", () => {
    const sources = [
      { path: "packages/a/src/x.ts", content: `({ "x-api-key": k })` },
      { path: "packages/b/src/y.ts", content: `({ "x-api-key": k })` },
      { path: "packages/c/src/z.ts", content: `credentialFetch()` },
    ];
    const allowlist = [
      { id: "a", path: "packages/a/src/x.ts", ticket: "SAP-1" },
      { id: "c", path: "packages/c/src/z.ts", ticket: "SAP-1" },
    ];
    const { violations, stale } = audit(sources, allowlist);
    assert.deepEqual(violations, ["packages/b/src/y.ts:1"]);
    assert.deepEqual(
      stale.map((entry) => entry.id),
      ["c"],
    );
  });

  it("passes on the repository", async () => {
    assert.deepEqual(await auditRepository(), { violations: [], stale: [] });
  });
});
