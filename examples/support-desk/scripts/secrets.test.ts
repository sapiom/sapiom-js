import { AgentOperationError } from "@sapiom/agent-core";
import { describe, expect, it } from "vitest";

import {
  SecretProvisionError,
  WATCHDOG_SECRET,
  ensureWatchdogKey,
} from "./secrets";

const SECRET_VALUE = "sk_live_minted";

function stub(opts: { keys?: string[]; mint?: Error; set?: Error } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = {
    async get(path: string) {
      calls.push({ method: "GET", path });
      return { keys: opts.keys ?? [] };
    },
    async post(path: string, body?: unknown) {
      calls.push({ method: "POST", path, body });
      if (opts.set) throw opts.set;
      return undefined;
    },
    async postAtHostRoot(path: string, body?: unknown) {
      calls.push({ method: "POST", path, body });
      if (opts.mint) throw opts.mint;
      return { apiKey: { id: "key-1" }, plainKey: SECRET_VALUE };
    },
  };
  return { client: client as never, calls };
}

const http403 = new AgentOperationError({ code: "HTTP_403", message: "no" });

describe("ensureWatchdogKey", () => {
  it("mints an org.read-only key and stores it as the definition secret", async () => {
    const { client, calls } = stub();
    const out = await ensureWatchdogKey(client, "def-1");
    expect(out).toEqual({ outcome: "provisioned", keyId: "key-1" });
    expect(calls[1]).toMatchObject({
      path: "/v1/api-keys/scoped",
      body: { permissions: ["org.read"], name: "sylon-watchdog (read runs)" },
    });
    expect(calls[2]).toEqual({
      method: "POST",
      path: "/definitions/def-1/secrets",
      body: { key: WATCHDOG_SECRET, secret: SECRET_VALUE },
    });
    expect(JSON.stringify(out)).not.toContain(SECRET_VALUE);
  });

  it("does nothing when the secret is already set", async () => {
    const { client, calls } = stub({ keys: [WATCHDOG_SECRET] });
    expect(await ensureWatchdogKey(client, "def-1")).toEqual({
      outcome: "present",
    });
    expect(calls).toHaveLength(1);
  });

  it("names the missing permission and the manual route on a 403 from minting", async () => {
    const { client } = stub({ mint: http403 });
    const err = await ensureWatchdogKey(client, "def-1").catch((e) => e);
    expect(err).toBeInstanceOf(SecretProvisionError);
    expect(err.message).toMatch(/org\.api_keys\.write/);
    expect(err.message).toMatch(/Secrets tab/);
    expect(err.message).not.toContain(SECRET_VALUE);
  });

  it("rethrows other failures untouched", async () => {
    const boom = new Error("network down");
    await expect(
      ensureWatchdogKey(stub({ mint: boom }).client, "def-1"),
    ).rejects.toBe(boom);
  });
});
