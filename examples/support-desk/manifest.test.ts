import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest, type AgentDefinition } from "@sapiom/agent";
import { describe, expect, it } from "vitest";

// The deploy build turns every step's inputSchema into JSON Schema. Unit tests that call steps
// directly never do, so a schema the build rejects (z.custom, z.function, ...) only failed at deploy.
const AGENTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "agents",
);
const projects = readdirSync(AGENTS, { withFileTypes: true })
  .filter(
    (d) => d.isDirectory() && existsSync(path.join(AGENTS, d.name, "index.ts")),
  )
  .map((d) => d.name);

describe("deploy manifest", () => {
  it.each(projects)("%s builds a manifest", async (name) => {
    const mod = (await import(path.join(AGENTS, name, "index.ts"))) as {
      agent: AgentDefinition;
    };
    expect(() =>
      buildManifest(mod.agent, {
        sdkVersion: "test",
        artifact: { sha256: "0".repeat(64), entryFile: "index.js" },
      }),
    ).not.toThrow();
  });
});
