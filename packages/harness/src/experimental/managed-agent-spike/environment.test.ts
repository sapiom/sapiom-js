import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MANAGED_AGENT_FORBIDDEN_AMBIENT_CREDENTIALS,
  MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES,
} from "./contract.js";
import { buildManagedAgentChildEnvironment } from "./environment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed-agent child environment", () => {
  it("starts empty, passes only positive-listed ambient values, and pins every model variable", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "managed-agent-env-"));
    roots.push(configRoot);
    const child = buildManagedAgentChildEnvironment({
      ambient: {
        PATH: "/safe/bin",
        LANG: "en_US.UTF-8",
        ANTHROPIC_API_KEY: "ambient-anthropic-key",
        CLAUDE_CODE_OAUTH_TOKEN: "ambient-user-login",
        SAPIOM_API_KEY: "ambient-sapiom-key",
        HOST_ESBUILD_PIN: "/must/not/leak",
        FUTURE_CREDENTIAL_SOURCE: "future-secret",
      },
      configRoot,
      gatewayOrigin: "https://gateway.example.test",
      gatewayCredential: "dedicated-eval-key",
      modelAlias: "claude-sonnet-5-anthropic-anthropic-eval",
      evalSource: "eval-source",
      executionId: "execution-id",
    });

    expect(child.PATH).toBe("/safe/bin");
    expect(child.ANTHROPIC_API_KEY).toBe("dedicated-eval-key");
    expect(child.ANTHROPIC_BASE_URL).toBe("https://gateway.example.test");
    expect(child.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK).toBe("1");
    expect(child.CLAUDE_CODE_NO_MODEL_FALLBACK).toBe("1");
    for (const variable of MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES) {
      expect(child[variable]).toBe("claude-sonnet-5-anthropic-anthropic-eval");
    }
    for (const variable of MANAGED_AGENT_FORBIDDEN_AMBIENT_CREDENTIALS) {
      if (variable !== "ANTHROPIC_API_KEY")
        expect(child).not.toHaveProperty(variable);
    }
    expect(child).not.toHaveProperty("HOST_ESBUILD_PIN");
    expect(child).not.toHaveProperty("FUTURE_CREDENTIAL_SOURCE");
    expect(child.HOME).not.toBe(process.env.HOME);
    expect(child.CLAUDE_CONFIG_DIR).not.toBe(process.env.CLAUDE_CONFIG_DIR);
    expect(child.CLAUDE_SECURESTORAGE_CONFIG_DIR).not.toBe(
      child.CLAUDE_CONFIG_DIR,
    );
    for (const directory of [
      child.HOME,
      child.XDG_CONFIG_HOME,
      child.CLAUDE_CONFIG_DIR,
      child.CLAUDE_SECURESTORAGE_CONFIG_DIR,
      child.TMPDIR,
    ]) {
      expect((await stat(directory)).isDirectory()).toBe(true);
    }
  });

  it("uses a fresh canonical private root without following pre-existing child symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-agent-env-"));
    roots.push(root);
    const configRoot = join(root, "config");
    const external = join(root, "external-claude-config");
    await Promise.all([mkdir(configRoot), mkdir(external)]);
    await symlink(external, join(configRoot, "claude-config"));

    const first = buildManagedAgentChildEnvironment({
      ambient: {},
      configRoot,
      gatewayOrigin: "https://gateway.example.test",
      gatewayCredential: "dedicated-eval-key",
      modelAlias: "claude-sonnet-5-anthropic-anthropic-eval",
      evalSource: "eval-source",
      executionId: "execution-id",
    });
    const second = buildManagedAgentChildEnvironment({
      ambient: {},
      configRoot,
      gatewayOrigin: "https://gateway.example.test",
      gatewayCredential: "dedicated-eval-key",
      modelAlias: "claude-sonnet-5-anthropic-anthropic-eval",
      evalSource: "eval-source",
      executionId: "execution-id-2",
    });

    const privateRoot = dirname(first.CLAUDE_CONFIG_DIR);
    expect(privateRoot).not.toBe(dirname(second.CLAUDE_CONFIG_DIR));
    expect(await realpath(first.CLAUDE_CONFIG_DIR)).not.toBe(
      await realpath(external),
    );
    expect(
      (await lstat(join(configRoot, "claude-config"))).isSymbolicLink(),
    ).toBe(true);
    for (const directory of [
      first.HOME,
      first.USERPROFILE,
      first.APPDATA,
      first.LOCALAPPDATA,
      first.XDG_CONFIG_HOME,
      first.XDG_CACHE_HOME,
      first.XDG_DATA_HOME,
      first.CLAUDE_CONFIG_DIR,
      first.CLAUDE_SECURESTORAGE_CONFIG_DIR,
      first.TMPDIR,
      first.TMP,
      first.TEMP,
    ]) {
      const canonical = await realpath(directory);
      const pathRelative = relative(privateRoot, canonical);
      expect(isAbsolute(pathRelative)).toBe(false);
      expect(pathRelative).not.toBe("..");
      expect(pathRelative.startsWith(`..${sep}`)).toBe(false);
      expect((await lstat(directory)).isSymbolicLink()).toBe(false);
    }
  });

  it("rejects newline injection in correlation headers", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "managed-agent-env-"));
    roots.push(configRoot);
    expect(() =>
      buildManagedAgentChildEnvironment({
        ambient: {},
        configRoot,
        gatewayOrigin: "https://gateway.example.test",
        gatewayCredential: "dedicated-eval-key",
        modelAlias: "model",
        evalSource: "bad\nheader",
        executionId: "execution-id",
      }),
    ).toThrow("safe header");
  });
});
