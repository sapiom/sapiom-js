import { describe, expect, it } from "vitest";

import {
  ManagedAgentSettingsGuardError,
  assertManagedAgentHooksEnabled,
  buildManagedAgentSettingsGuardEnvironment,
} from "./settings-guard.js";

describe("managed-agent settings guard", () => {
  it("removes gateway and credential inputs before resolution", () => {
    expect(
      buildManagedAgentSettingsGuardEnvironment({
        PATH: "/safe/bin",
        HOME: "/isolated/home",
        CLAUDE_CONFIG_DIR: "/isolated/claude",
        ANTHROPIC_API_KEY: "credential",
        ANTHROPIC_AUTH_TOKEN: "auth-token",
        ANTHROPIC_BASE_URL: "https://gateway.invalid",
        ANTHROPIC_CUSTOM_HEADERS: "x-secret: value",
      }),
    ).toEqual({
      PATH: "/safe/bin",
      HOME: "/isolated/home",
      CLAUDE_CONFIG_DIR: "/isolated/claude",
    });
  });

  it("accepts only the exact enabled contract", async () => {
    const input = { cwd: process.cwd(), environment: {} };
    await expect(
      assertManagedAgentHooksEnabled(input, {
        run: async () => ({
          stdout: JSON.stringify({
            contractVersion: 1,
            disableAllHooks: false,
            policyHelperConfigured: false,
          }),
        }),
      }),
    ).resolves.toBeUndefined();

    for (const stdout of [
      "not-json",
      "{}",
      JSON.stringify({
        contractVersion: 1,
        disableAllHooks: "false",
        policyHelperConfigured: false,
      }),
      JSON.stringify({
        contractVersion: 1,
        disableAllHooks: false,
        policyHelperConfigured: false,
        unexpected: true,
      }),
    ]) {
      await expect(
        assertManagedAgentHooksEnabled(input, {
          run: async () => ({ stdout }),
        }),
      ).rejects.toBeInstanceOf(ManagedAgentSettingsGuardError);
    }
  });

  it("fails closed on disabled hooks or resolution errors", async () => {
    const input = { cwd: process.cwd(), environment: {} };
    await expect(
      assertManagedAgentHooksEnabled(input, {
        run: async () => ({
          stdout: JSON.stringify({
            contractVersion: 1,
            disableAllHooks: true,
            policyHelperConfigured: false,
          }),
        }),
      }),
    ).rejects.toThrow("disabled by managed settings");
    await expect(
      assertManagedAgentHooksEnabled(input, {
        run: async () => {
          throw new Error("private resolver error");
        },
      }),
    ).rejects.toThrow("could not be resolved");

    await expect(
      assertManagedAgentHooksEnabled(input, {
        run: async () => ({
          stdout: JSON.stringify({
            contractVersion: 1,
            disableAllHooks: false,
            policyHelperConfigured: true,
          }),
        }),
      }),
    ).rejects.toThrow("unresolved policy helper");
  });
});
