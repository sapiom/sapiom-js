/**
 * The Secrets router.
 *
 * What these guard, in order of how badly each would hurt: a VALUE reaching the
 * browser (never), a credential written into the wrong agent's namespace, and a
 * write that fails while reporting success.
 */

import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSecretsRouter } from "./secrets.js";
import {
  createPendingSecretsStore,
  type PendingSecretsStore,
} from "../core/pending-secrets.js";
import {
  VaultSecretError,
  type VaultSecretsClient,
} from "../core/vault-secrets.js";

const LINKED = "/agents/leasing";
const UNLINKED = "/agents/draft";

let tmpDir: string;
let pending: PendingSecretsStore;
let servers: { close: () => void }[] = [];

/** A fake vault recording every call, so a test can assert what was sent and
 *  to which definition. */
function makeVault(overrides: Partial<VaultSecretsClient> = {}) {
  const store = new Map<string, Map<string, string>>();
  const calls: { op: string; definitionId: string; key?: string }[] = [];
  const vault: VaultSecretsClient = {
    async list(definitionId) {
      calls.push({ op: "list", definitionId });
      return [...(store.get(definitionId)?.keys() ?? [])].sort();
    },
    async set(definitionId, key, value) {
      calls.push({ op: "set", definitionId, key });
      const bucket = store.get(definitionId) ?? new Map();
      bucket.set(key, value);
      store.set(definitionId, bucket);
    },
    async remove(definitionId, key) {
      calls.push({ op: "remove", definitionId, key });
      store.get(definitionId)?.delete(key);
    },
    ...overrides,
  };
  return { vault, calls, store };
}

function startApp(vault: VaultSecretsClient) {
  const app = express();
  app.use(express.json());
  app.use(
    createSecretsRouter({
      apiKey: "sk_test",
      pendingSecrets: pending,
      vault,
      resolveWorkflow: (id) =>
        id === LINKED || id === UNLINKED ? { path: id } : null,
      // `sapiom.json` stands in for linkedness: LINKED has a definitionId.
      readConfig: ((dir: string) =>
        dir === LINKED ? { definitionId: "188" } : {}) as never,
    }),
  );
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const url = (base: string, id: string, suffix = ""): string =>
  `${base}/api/workflows/${encodeURIComponent(id)}/secrets${suffix}`;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-secrets-router-"));
  pending = await createPendingSecretsStore(
    path.join(tmpDir, "pending-secrets.json"),
  );
});

afterEach(async () => {
  for (const server of servers) server.close();
  servers = [];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GET /api/workflows/:id/secrets", () => {
  it("never returns a value, only names and states", async () => {
    const { vault } = makeVault();
    const base = startApp(vault);
    await fetch(url(base, LINKED), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "API_KEY", secret: "sk-super-secret" }),
    });

    const response = await fetch(url(base, LINKED));
    const raw = await response.text();

    // The strongest form of this assertion: the secret does not appear
    // ANYWHERE in the serialized body, whatever the field names are.
    expect(raw).not.toContain("sk-super-secret");
    expect(JSON.parse(raw).secrets).toEqual([
      { name: "API_KEY", state: "synced", hasLocalCopy: true },
    ]);
  });

  it("marks a value pending when the agent is not linked", async () => {
    const { vault, calls } = makeVault();
    const base = startApp(vault);
    await fetch(url(base, UNLINKED), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "NOTION_TOKEN", secret: "ntn" }),
    });

    const body = await (await fetch(url(base, UNLINKED))).json();
    expect(body.linked).toBe(false);
    expect(body.secrets).toEqual([
      { name: "NOTION_TOKEN", state: "pending", hasLocalCopy: true },
    ]);
    // Nothing was sent upstream — there is no definition to send it to.
    expect(calls.filter((c) => c.op === "set")).toEqual([]);
  });

  it("keeps one agent's secrets out of another's", async () => {
    const { vault } = makeVault();
    const base = startApp(vault);
    await fetch(url(base, LINKED), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "LEASING_ONLY", secret: "v" }),
    });

    const other = await (await fetch(url(base, UNLINKED))).json();
    expect(other.secrets).toEqual([]);
  });

  it("distinguishes an unreadable vault from an empty one", async () => {
    const { vault } = makeVault({ list: async () => null });
    const base = startApp(vault);

    const body = await (await fetch(url(base, LINKED))).json();
    // Saying "no secrets" when we could not look would invite re-adding a
    // credential that is already there.
    expect(body.unreadable).toBe(true);
    expect(body.secrets).toEqual([]);
  });

  it("404s an unknown agent", async () => {
    const { vault } = makeVault();
    const base = startApp(vault);
    const response = await fetch(url(base, "/agents/nope"));
    expect(response.status).toBe(404);
  });
});

describe("POST /api/workflows/:id/secrets", () => {
  it("writes to the definition from sapiom.json, not one the caller names", async () => {
    const { vault, calls } = makeVault();
    const base = startApp(vault);
    await fetch(url(base, LINKED), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "API_KEY",
        secret: "v",
        // A caller trying to steer the write elsewhere must be ignored.
        definitionId: "999",
      }),
    });
    expect(calls.filter((c) => c.op === "set")).toEqual([
      { op: "set", definitionId: "188", key: "API_KEY" },
    ]);
  });

  it("reports a refused write as 502 and does not claim success", async () => {
    const { vault } = makeVault({
      set: async () => {
        throw new VaultSecretError("API_KEY was rejected: not authorized.", 403);
      },
    });
    const base = startApp(vault);
    const response = await fetch(url(base, LINKED), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "API_KEY", secret: "v" }),
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("API_KEY");
  });

  it("rejects an empty key or secret", async () => {
    const { vault } = makeVault();
    const base = startApp(vault);
    for (const body of [{ key: "", secret: "v" }, { key: "A", secret: "" }]) {
      const response = await fetch(url(base, LINKED), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("POST /api/workflows/:id/secrets/import", () => {
  it("reports per-key outcomes when only some land", async () => {
    const { vault } = makeVault({
      set: async (_definitionId, key) => {
        if (key === "THIRD") throw new VaultSecretError("THIRD failed.", 500);
      },
    });
    const base = startApp(vault);

    const response = await fetch(url(base, LINKED, "/import"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: [
          { key: "FIRST", secret: "1" },
          { key: "SECOND", secret: "2" },
          { key: "THIRD", secret: "3" },
        ],
      }),
    });

    const body = await response.json();
    // An import that lands two of three and says "imported" is the failure the
    // parse preview exists to prevent; it must not come back on the write side.
    expect(body.uploaded).toEqual(["FIRST", "SECOND"]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].key).toBe("THIRD");
  });
});

describe("POST /api/workflows/:id/secrets/flush", () => {
  it("uploads everything held locally and keeps the local copy", async () => {
    const { vault, store } = makeVault();
    const base = startApp(vault);
    await pending.set(LINKED, "A", "1");
    await pending.set(LINKED, "B", "2");

    const body = await (
      await fetch(url(base, LINKED, "/flush"), { method: "POST" })
    ).json();

    expect(body.uploaded).toEqual(["A", "B"]);
    expect([...store.get("188")!.keys()].sort()).toEqual(["A", "B"]);
    // The vault has no read path, so dropping the local copy would mean local
    // runs silently lose their credentials with no way to get them back.
    expect(pending.names(LINKED)).toEqual(["A", "B"]);
  });

  it("409s an unlinked agent rather than pretending to upload", async () => {
    const { vault } = makeVault();
    const base = startApp(vault);
    await pending.set(UNLINKED, "A", "1");

    const response = await fetch(url(base, UNLINKED, "/flush"), {
      method: "POST",
    });
    expect(response.status).toBe(409);
  });
});

describe("DELETE /api/workflows/:id/secrets/:key", () => {
  it("removes from the vault and locally by default", async () => {
    const { vault, store, calls } = makeVault();
    const base = startApp(vault);
    await fetch(url(base, LINKED), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "API_KEY", secret: "v" }),
    });

    const response = await fetch(url(base, LINKED, "/API_KEY"), {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    expect(store.get("188")!.has("API_KEY")).toBe(false);
    expect(pending.names(LINKED)).toEqual([]);
    expect(calls.some((c) => c.op === "remove")).toBe(true);
  });

  it("?local drops only the local copy, leaving the deployed credential", async () => {
    const { vault, store, calls } = makeVault();
    const base = startApp(vault);
    await fetch(url(base, LINKED), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "API_KEY", secret: "v" }),
    });

    await fetch(url(base, LINKED, "/API_KEY?local"), { method: "DELETE" });
    expect(pending.names(LINKED)).toEqual([]);
    expect(store.get("188")!.has("API_KEY")).toBe(true);
    expect(calls.some((c) => c.op === "remove")).toBe(false);
  });

  it("deletes a PENDING key on a linked agent, which the vault has never seen", async () => {
    // The state the pending banner exists to describe: added while unlinked,
    // then linked (or deployed from the terminal). The vault 404s a key it was
    // never given, and treating that as a failure left the row undeletable —
    // the delete dialog offers "remove local copy only" only when the key is
    // ALSO synced, so this row's one offered action was the one that fails.
    const { vault } = makeVault({
      remove: async (_definitionId, key) => {
        throw new VaultSecretError(`${key} could not be stored: not found.`, 404);
      },
    });
    const base = startApp(vault);
    await pending.set(LINKED, "NEVER_UPLOADED", "v");

    const response = await fetch(url(base, LINKED, "/NEVER_UPLOADED"), {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(pending.names(LINKED)).toEqual([]);
  });

  it("keeps the local copy when the vault refuses the delete", async () => {
    const { vault } = makeVault({
      remove: async () => {
        throw new VaultSecretError("API_KEY could not be removed.", 500);
      },
    });
    const base = startApp(vault);
    await pending.set(LINKED, "API_KEY", "v");

    const response = await fetch(url(base, LINKED, "/API_KEY"), {
      method: "DELETE",
    });
    // Dropping the local copy after a failed remote delete would leave the
    // credential live in the cloud and invisible in the tab.
    expect(response.status).toBe(502);
    expect(pending.names(LINKED)).toEqual(["API_KEY"]);
  });
});
