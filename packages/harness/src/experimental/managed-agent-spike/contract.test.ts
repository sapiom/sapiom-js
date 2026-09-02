import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MANAGED_AGENT_CONTRACT,
  MANAGED_AGENT_L1_CERTIFICATION_CONTRACT,
  MANAGED_AGENT_L1_FINAL_BYTE_ROLES,
  MANAGED_AGENT_L1_REGISTERED_PATH_ROLES,
  MANAGED_AGENT_MODEL_TARGETS,
  ManagedAgentConfigurationError,
  assertManagedAgentDirectGatewayOrigin,
  normalizeManagedAgentGatewayOrigin,
  normalizeManagedAgentHermeticGatewayOrigin,
  resolveManagedAgentModelTarget,
  validateManagedAgentProbeConfig,
} from "./contract.js";
import type { ManagedAgentProbeConfig } from "./types.js";

const roots: string[] = [];

async function config(): Promise<ManagedAgentProbeConfig> {
  const root = await mkdtemp(join(tmpdir(), "managed-agent-contract-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const configRoot = join(root, "config");
  await Promise.all([mkdir(workspaceRoot), mkdir(configRoot)]);
  return {
    scenario: "L1",
    workspaceRoot,
    configRoot,
    target: "sonnet-5",
    gatewayOrigin: MANAGED_AGENT_CONTRACT.directGatewayOrigin,
    gatewayCredential: "dedicated-eval-key",
    prompt: `${MANAGED_AGENT_L1_CERTIFICATION_CONTRACT.promptMarker}\nprobe`,
    maxTurns: 10,
    maxBudgetUsd: 0.25,
    allowedBashCommands: ["git status --short"],
    pathRoleBindings: [
      { path: "clean.txt", role: "clean_target" },
      { path: "dirty.txt", role: "dirty_sentinel" },
      { path: "untracked.txt", role: "untracked_sentinel" },
      { path: "created.txt", role: "managed_output" },
      { path: "../outside.txt", role: "outside_sentinel" },
      { path: "escape.txt", role: "escape_link" },
    ],
    expectedL1FinalBytes: [
      { path: "clean.txt", role: "clean_target", sha256: "a".repeat(64) },
      { path: "created.txt", role: "managed_output", sha256: "b".repeat(64) },
    ],
    expectedMcpNonce: "probe-nonce",
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed-agent contract", () => {
  it("freezes the versioned L1 prompt and evaluator contract", () => {
    expect(MANAGED_AGENT_L1_CERTIFICATION_CONTRACT).toEqual({
      contractVersion: 2,
      promptVersion: "managed-agent-l1-prompt-v2",
      promptMarker: "SAPIOM_MANAGED_AGENT_L1_PROMPT_V2",
      evaluatorVersion: "managed-agent-l1-evaluator-v2",
    });
    expect(Object.isFrozen(MANAGED_AGENT_L1_CERTIFICATION_CONTRACT)).toBe(true);
    expect(Object.isFrozen(MANAGED_AGENT_L1_REGISTERED_PATH_ROLES)).toBe(true);
    expect(Object.isFrozen(MANAGED_AGENT_L1_FINAL_BYTE_ROLES)).toBe(true);
  });

  it("pins the certified SDK/runtime and exact two-model allowlist", () => {
    expect(MANAGED_AGENT_CONTRACT).toMatchObject({
      agentSdkVersion: "0.3.228",
      claudeCodeRuntimeVersion: "2.1.228",
      certificationNodeVersion: "22.23.2",
      directGatewayOrigin: "https://litellm.services.sapiom.ai",
    });
    expect(MANAGED_AGENT_MODEL_TARGETS).toEqual({
      "sonnet-5": expect.objectContaining({
        alias: "claude-sonnet-5-anthropic-anthropic-eval",
      }),
      "minimax-m3": expect.objectContaining({
        alias: "minimax-m3-fireworks-sapiom-fireworks_ai-eval",
      }),
    });
  });

  it("rejects arbitrary models instead of accepting a gateway label", () => {
    expect(() =>
      resolveManagedAgentModelTarget("claude-anything" as "sonnet-5"),
    ).toThrow(ManagedAgentConfigurationError);
  });

  it("accepts only a credential-free HTTP(S) origin", () => {
    expect(
      normalizeManagedAgentGatewayOrigin("https://gateway.example.test/"),
    ).toBe("https://gateway.example.test");
    for (const value of [
      "file:///tmp/gateway",
      "https://user:pass@gateway.example.test",
      "https://gateway.example.test/v1",
      "https://gateway.example.test?token=x",
    ]) {
      expect(() => normalizeManagedAgentGatewayOrigin(value)).toThrow(
        ManagedAgentConfigurationError,
      );
    }
  });

  it("pins live traffic to the certified direct gateway origin", () => {
    expect(
      assertManagedAgentDirectGatewayOrigin(
        "https://litellm.services.sapiom.ai/",
      ),
    ).toBe(MANAGED_AGENT_CONTRACT.directGatewayOrigin);
    expect(() =>
      assertManagedAgentDirectGatewayOrigin(
        "https://llm.services.proxy.sapiom.ai",
      ),
    ).toThrow("pinned direct Sapiom gateway origin");
  });

  it("limits the explicit hermetic origin seam to .test and loopback", () => {
    for (const value of [
      "https://gateway.example.test",
      "http://localhost:4312",
      "http://agent.localhost:4312",
      "http://127.0.0.1:4312",
      "http://[::1]:4312",
    ]) {
      expect(normalizeManagedAgentHermeticGatewayOrigin(value)).toBe(
        normalizeManagedAgentGatewayOrigin(value),
      );
    }
    for (const value of [
      MANAGED_AGENT_CONTRACT.directGatewayOrigin,
      "https://gateway.example.com",
    ]) {
      expect(() => normalizeManagedAgentHermeticGatewayOrigin(value)).toThrow(
        "reserved .test or loopback",
      );
    }
  });

  it("canonicalizes disjoint roots and bounds turns and budget", async () => {
    const valid = await config();
    const checked = validateManagedAgentProbeConfig(valid);
    expect(checked.canonicalWorkspaceRoot).toBe(
      await realpath(valid.workspaceRoot),
    );
    expect(checked.model.id).toBe("sonnet-5");
    expect(() =>
      validateManagedAgentProbeConfig({ ...valid, maxBudgetUsd: 1.01 }),
    ).toThrow("maxBudgetUsd");
    expect(() =>
      validateManagedAgentProbeConfig({ ...valid, maxTurns: 21 }),
    ).toThrow("maxTurns");
    expect(() =>
      validateManagedAgentProbeConfig({
        ...valid,
        configRoot: valid.workspaceRoot,
      }),
    ).toThrow("disjoint");
    expect(() =>
      validateManagedAgentProbeConfig({
        ...valid,
        expectedMcpNonce: undefined,
      }),
    ).toThrow("expectedMcpNonce");
  });

  it("requires the exact L1 v2 marker and all six unique path roles", async () => {
    const valid = await config();
    expect(() =>
      validateManagedAgentProbeConfig({
        ...valid,
        prompt: "SAPIOM_MANAGED_AGENT_L1_PROMPT_V1\nprobe",
      }),
    ).toThrow("managed-agent-l1-prompt-v2 marker");
    expect(() =>
      validateManagedAgentProbeConfig({
        ...valid,
        pathRoleBindings: valid.pathRoleBindings.slice(0, -1),
      }),
    ).toThrow("each frozen fixture role exactly once");
    expect(() =>
      validateManagedAgentProbeConfig({
        ...valid,
        pathRoleBindings: valid.pathRoleBindings.map((binding, index) =>
          index === 1 ? { ...binding, path: "clean.txt" } : binding,
        ),
      }),
    ).toThrow("each frozen fixture role exactly once");
  });

  it("requires exact trusted hashes for both intended L1 mutation roles", async () => {
    const valid = await config();
    for (const expectedL1FinalBytes of [
      valid.expectedL1FinalBytes.slice(0, 1),
      valid.expectedL1FinalBytes.map((expectation, index) =>
        index === 0 ? { ...expectation, sha256: "not-a-hash" } : expectation,
      ),
      valid.expectedL1FinalBytes.map((expectation, index) =>
        index === 0 ? { ...expectation, path: "dirty.txt" } : expectation,
      ),
    ]) {
      expect(() =>
        validateManagedAgentProbeConfig({
          ...valid,
          expectedL1FinalBytes,
        }),
      ).toThrow("exact hashes");
    }
  });

  it("keeps L2 free of L1 path-role and final-byte configuration", async () => {
    const valid = await config();
    const l2: ManagedAgentProbeConfig = {
      ...valid,
      scenario: "L2",
      prompt: "run exact Bash",
      pathRoleBindings: [],
      expectedL1FinalBytes: [],
      expectedMcpNonce: undefined,
    };
    expect(() => validateManagedAgentProbeConfig(l2)).not.toThrow();
    expect(() =>
      validateManagedAgentProbeConfig({
        ...l2,
        pathRoleBindings: valid.pathRoleBindings,
      }),
    ).toThrow("L2 must not configure");
    expect(() =>
      validateManagedAgentProbeConfig({
        ...l2,
        expectedL1FinalBytes: valid.expectedL1FinalBytes,
      }),
    ).toThrow("L2 must not configure");
  });

  it("requires exact agreement with an explicitly selected hermetic origin", async () => {
    const valid = await config();
    const gatewayOrigin = "https://gateway.example.test";
    expect(
      validateManagedAgentProbeConfig(
        { ...valid, gatewayOrigin },
        { hermeticGatewayOrigin: gatewayOrigin },
      ).gatewayOrigin,
    ).toBe(gatewayOrigin);
    expect(() =>
      validateManagedAgentProbeConfig(
        { ...valid, gatewayOrigin },
        { hermeticGatewayOrigin: "https://other.example.test" },
      ),
    ).toThrow("explicit hermetic gateway origin");
  });
});
