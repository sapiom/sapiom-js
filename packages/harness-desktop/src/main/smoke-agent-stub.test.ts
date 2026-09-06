import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { captureAgentEnvironment, environmentCapturePath } =
  require("../../scripts/smoke-agent-stub.cjs") as {
    captureAgentEnvironment: (env: Record<string, string>) => string | null;
    environmentCapturePath: (base: string, sessionId: string) => string;
  };

describe("packaged smoke agent environment evidence", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains exact per-session snapshots regardless of competing write order", () => {
    const root = mkdtempSync(path.join(tmpdir(), "smoke-agent-env-"));
    roots.push(root);
    const base = path.join(root, "agent-env");
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";

    const secondFile = captureAgentEnvironment({
      SAPIOM_SMOKE_AGENT_ENV: base,
      SAPIOM_HARNESS_SESSION_ID: secondId,
      PATH: "/bin",
      PRIVATE_VALUE: "must-not-be-copied",
    });
    const firstFile = captureAgentEnvironment({
      SAPIOM_SMOKE_AGENT_ENV: base,
      SAPIOM_HARNESS_SESSION_ID: firstId,
      PATH: "/bin",
    });

    expect(firstFile).toBe(environmentCapturePath(base, firstId));
    expect(secondFile).toBe(environmentCapturePath(base, secondId));
    expect(firstFile).not.toBe(secondFile);
    expect(JSON.parse(readFileSync(firstFile!, "utf8"))).toMatchObject({
      schemaVersion: 1,
      sessionId: firstId,
      hasEsbuildBinaryPath: false,
      hasPath: true,
    });
    const secondRaw = readFileSync(secondFile!, "utf8");
    expect(JSON.parse(secondRaw)).toMatchObject({
      schemaVersion: 1,
      sessionId: secondId,
      hasEsbuildBinaryPath: false,
      hasPath: true,
    });
    expect(secondRaw).not.toContain("must-not-be-copied");
  });
});
