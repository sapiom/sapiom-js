import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPendingSecretsStore } from "./pending-secrets.js";

/**
 * What these guard, in order of how badly each would hurt: a plaintext
 * credential file anyone on the machine can read, a value reaching the browser,
 * and a write that is lost or half-written.
 */

let tmpDir: string;
const storePath = (): string => path.join(tmpDir, "pending-secrets.json");
const PROJECT = "/Users/x/agents/leasing";
const OTHER = "/Users/x/agents/outreach";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-pending-secrets-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createPendingSecretsStore", () => {
  it("round-trips a value through disk", async () => {
    const store = await createPendingSecretsStore(storePath());
    await store.set(PROJECT, "ANTHROPIC_API_KEY", "sk-ant-secret");

    const reopened = await createPendingSecretsStore(storePath());
    expect(reopened.names(PROJECT)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(reopened.values(PROJECT)).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-secret",
    });
  });

  it("keeps one project's secrets out of another's", async () => {
    const store = await createPendingSecretsStore(storePath());
    await store.set(PROJECT, "NOTION_TOKEN", "ntn-1");
    await store.set(OTHER, "HUBSPOT_TOKEN", "hub-1");

    expect(store.names(PROJECT)).toEqual(["NOTION_TOKEN"]);
    expect(store.names(OTHER)).toEqual(["HUBSPOT_TOKEN"]);
    expect(store.values(PROJECT)).not.toHaveProperty("HUBSPOT_TOKEN");
  });

  it("replaces rather than duplicates a name on the same project", async () => {
    const store = await createPendingSecretsStore(storePath());
    await store.set(PROJECT, "API_KEY", "first");
    await store.set(PROJECT, "API_KEY", "second");

    expect(store.names(PROJECT)).toEqual(["API_KEY"]);
    expect(store.values(PROJECT)).toEqual({ API_KEY: "second" });
  });

  it("sorts names, so the tab's order never depends on insertion order", async () => {
    const store = await createPendingSecretsStore(storePath());
    await store.set(PROJECT, "ZED", "z");
    await store.set(PROJECT, "ALPHA", "a");
    expect(store.names(PROJECT)).toEqual(["ALPHA", "ZED"]);
  });

  it("hands back copies, so a caller cannot mutate the store through them", async () => {
    const store = await createPendingSecretsStore(storePath());
    await store.set(PROJECT, "API_KEY", "real");

    const values = store.values(PROJECT);
    values.API_KEY = "tampered";
    delete values.API_KEY;

    expect(store.values(PROJECT)).toEqual({ API_KEY: "real" });
  });

  describe("file permissions", () => {
    it("creates the file 0600 and its directory 0700", async () => {
      const nested = path.join(tmpDir, "state", "pending-secrets.json");
      const store = await createPendingSecretsStore(nested);
      await store.set(PROJECT, "API_KEY", "v");

      expect((await fs.stat(nested)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(nested))).mode & 0o777).toBe(0o700);
    });

    it("hardens a pre-existing, loosely-permissioned file on the next write", async () => {
      const store = await createPendingSecretsStore(storePath());
      await store.set(PROJECT, "API_KEY", "v");
      await fs.chmod(storePath(), 0o644);
      expect((await fs.stat(storePath())).mode & 0o777).toBe(0o644);

      await store.set(PROJECT, "OTHER_KEY", "w");
      expect((await fs.stat(storePath())).mode & 0o777).toBe(0o600);
    });

    it("leaves no readable temp file behind", async () => {
      const store = await createPendingSecretsStore(storePath());
      await store.set(PROJECT, "API_KEY", "v");
      const left = await fs.readdir(tmpDir);
      expect(left.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  describe("removal", () => {
    it("forgets one name and keeps the rest", async () => {
      const store = await createPendingSecretsStore(storePath());
      await store.set(PROJECT, "A", "1");
      await store.set(PROJECT, "B", "2");
      await store.remove(PROJECT, "A");

      expect(store.names(PROJECT)).toEqual(["B"]);
      const reopened = await createPendingSecretsStore(storePath());
      expect(reopened.names(PROJECT)).toEqual(["B"]);
    });

    it("removeMany drops exactly the named keys", async () => {
      const store = await createPendingSecretsStore(storePath());
      await store.set(PROJECT, "A", "1");
      await store.set(PROJECT, "B", "2");
      await store.set(PROJECT, "C", "3");
      await store.removeMany(PROJECT, ["A", "C"]);
      expect(store.names(PROJECT)).toEqual(["B"]);
    });

    it("drops the project key entirely once its last secret goes", async () => {
      const store = await createPendingSecretsStore(storePath());
      await store.set(PROJECT, "ONLY", "1");
      await store.remove(PROJECT, "ONLY");

      // An empty `{ "<path>": {} }` record reads as "this project has secrets"
      // to anything scanning the file, and it is not true.
      const onDisk = JSON.parse(await fs.readFile(storePath(), "utf-8"));
      expect(onDisk).toEqual({});
    });
  });

  describe("recovery", () => {
    it("starts empty when the file does not exist", async () => {
      const store = await createPendingSecretsStore(storePath());
      expect(store.names(PROJECT)).toEqual([]);
    });

    it("starts empty on unparseable JSON, and does NOT delete the file", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await fs.writeFile(storePath(), "{ this is not json");

      const store = await createPendingSecretsStore(storePath());
      expect(store.names(PROJECT)).toEqual([]);
      // The values may be recoverable by hand; destroying them would be worse
      // than starting empty.
      expect(await fs.readFile(storePath(), "utf-8")).toBe("{ this is not json");
    });

    it("drops a wrong-shaped project entry without losing the good ones", async () => {
      await fs.writeFile(
        storePath(),
        JSON.stringify({
          [PROJECT]: { GOOD: "yes", BAD_NUMBER: 42, BAD_NESTED: { a: 1 } },
          [OTHER]: "not-an-object",
        }),
      );

      const store = await createPendingSecretsStore(storePath());
      expect(store.names(PROJECT)).toEqual(["GOOD"]);
      expect(store.names(OTHER)).toEqual([]);
    });

    it("keeps the value in memory when the disk write fails", async () => {
      // A real unwritable location rather than a spy: `fs`'s ESM namespace is
      // not configurable, and a genuine ENOTDIR exercises the same path the
      // user's read-only checkout would.
      const blocker = path.join(tmpDir, "not-a-dir");
      await fs.writeFile(blocker, "");
      const store = await createPendingSecretsStore(
        path.join(blocker, "pending-secrets.json"),
      );

      await store.set(PROJECT, "API_KEY", "v");

      // The run that is about to happen still gets the credential; the next
      // successful write reconciles. Losing it in memory too is strictly worse.
      expect(store.values(PROJECT)).toEqual({ API_KEY: "v" });
    });
  });
});
