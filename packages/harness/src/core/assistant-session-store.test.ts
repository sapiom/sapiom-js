import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AssistantSessionStore } from "./assistant-session-store.js";
import {
  assistantDirectory,
  writeAssistantJson,
} from "./assistant-session-files.js";
import {
  contextAuthorityScope,
  nativeAuthorityScope,
} from "./assistant-authority.js";
import { OpenCodeAssociations } from "./opencode-association.js";
import type { HostedOpenCode } from "./opencode-host.js";
import type { AssistantGrant } from "./assistant-access.js";

let root: string;
let store: AssistantSessionStore;
const key = {
  harnessSessionId: "studio-one",
  contextAuthorityScope: "a".repeat(64),
  cwd: "/project",
};
const nativeScope = "b".repeat(64);
const create = vi.fn(async () => "ses_new");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assistant-session-"));
  store = new AssistantSessionStore(root);
  create.mockClear();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function legacy(
  value: unknown = { version: 1, conversationId: "ses_original" },
) {
  const directory = join(root, "opencode", nativeScope);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "association.json"), JSON.stringify(value));
  return directory;
}

it("imports concurrently without native calls and survives loss of the native directory", async () => {
  const nativeRoot = await legacy();
  const [a, b] = await Promise.all([
    store.associate(key, nativeScope, create),
    new AssistantSessionStore(root).associate(key, nativeScope, create),
  ]);
  expect(a).toEqual(b);
  expect(a?.conversationId).toBe("ses_original");
  expect(create).not.toHaveBeenCalled();
  await rm(nativeRoot, { recursive: true });
  expect(await store.association(key)).toEqual(a);
  expect(await store.associate(key, nativeScope, create)).toEqual(a);
});

it("does not adopt another account/environment's imported sidecar", async () => {
  await legacy();
  await store.associate(key, nativeScope, create);
  const other = { ...key, contextAuthorityScope: "c".repeat(64) };
  expect(await store.associate(other, nativeScope, undefined)).toBeNull();
  expect(
    (await store.associate(other, nativeScope, create))?.conversationId,
  ).toBe("ses_new");
  expect((await store.association(key))?.conversationId).toBe("ses_original");
});

it("fails on malformed or contradictory bindings, never allocating a substitute", async () => {
  await legacy({ version: 1, conversationId: "studio-one" });
  await expect(store.associate(key, nativeScope, create)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  await legacy();
  await store.associate(key, nativeScope, create);
  await expect(store.association({ ...key, cwd: "/other" })).rejects.toThrow();
  await expect(store.associate(key, "d".repeat(64), create)).rejects.toThrow();
});

it("persists End without an Assistant binding or grant and rejects stale transitions", async () => {
  const ended = await store.transition(key.harnessSessionId, 0, {
    lifecycle: "ended",
    execution: "paused",
  });
  expect(
    await new AssistantSessionStore(root).lifecycle(key.harnessSessionId),
  ).toEqual(ended);
  await expect(
    store.transition(key.harnessSessionId, 0, {
      lifecycle: "open",
      execution: "enabled",
    }),
  ).rejects.toThrow("changed");
  expect(await store.association(key)).toBeNull();
});

it("rejects contradictory identities while scanning other bindings before legacy import", async () => {
  await legacy();
  const directory = await assistantDirectory(
    root,
    key.harnessSessionId,
    "c".repeat(64),
  );
  await writeAssistantJson(directory, "association.json", {
    version: 1,
    ...key,
    nativeScope,
    conversationId: "ses_other",
    createdAt: 1,
  });
  await expect(store.associate(key, nativeScope, create)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

it("keeps the previous durable checkpoint when cancellation interrupts a write", async () => {
  const ended = await store.transition(key.harnessSessionId, 0, {
    lifecycle: "ended",
    execution: "paused",
  });
  const directory = await assistantDirectory(root, key.harnessSessionId);
  await expect(
    writeAssistantJson(
      directory,
      "lifecycle.json",
      { ...ended, revision: 2 },
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
  expect(await store.lifecycle(key.harnessSessionId)).toEqual(ended);
  await writeFile(join(directory, "lifecycle.json"), "null");
  await expect(store.lifecycle(key.harnessSessionId)).rejects.toThrow();
});

it("rejects path traversal and symlink directories before reading external content", async () => {
  await expect(store.lifecycle("../outside")).rejects.toThrow();
  await mkdir(join(root, "assistant-sessions"));
  await symlink(root, join(root, "assistant-sessions", "studio-one"), "dir");
  await expect(store.association(key)).rejects.toThrow();
});

it("verifies the retained native ID and reports missing history without replacement", async () => {
  const stateRoot = await legacy();
  const fetch = vi.fn(async () => Response.json({ id: "ses_original" }));
  const hosted = {
    ...key,
    stateRoot,
    signal: new AbortController().signal,
    server: { fetch, fetchJson: create },
  } as unknown as HostedOpenCode;
  expect(await new OpenCodeAssociations(store).ensure(hosted)).toBe(
    "ses_original",
  );
  fetch.mockResolvedValue(new Response(null, { status: 404 }));
  await expect(
    new OpenCodeAssociations(store).ensure(hosted),
  ).rejects.toMatchObject({ failure: { code: "native_history_missing" } });
  expect(create).not.toHaveBeenCalled();
  expect(
    JSON.parse(await readFile(join(stateRoot, "association.json"), "utf8")),
  ).toEqual({ version: 1, conversationId: "ses_original" });
});

it("shares stable context authority with live hosts while retaining the old native mapping", () => {
  const grant: AssistantGrant = {
    userId: "u",
    tenantId: "t",
    identityRevision: "old",
    expiresAt: 1,
    environment: {
      name: "prod",
      apiURL: "https://api.example.test/",
      appURL: "https://app.example.test",
      services: {},
      credentials: null,
    },
  };
  const rotated = { ...grant, identityRevision: "new", expiresAt: 2 };
  expect(contextAuthorityScope(grant, key)).toBe(
    contextAuthorityScope(rotated, key),
  );
  const otherEnvironment = {
    ...grant,
    environment: { ...grant.environment, name: "dev" },
  };
  expect(contextAuthorityScope(grant, key)).not.toBe(
    contextAuthorityScope(otherEnvironment, key),
  );
  expect(nativeAuthorityScope(grant, key)).toBe(
    nativeAuthorityScope(otherEnvironment, key),
  );
  expect(() =>
    contextAuthorityScope(
      {
        ...grant,
        environment: {
          ...grant.environment,
          apiURL: "https://user:secret@example.test",
        },
      },
      key,
    ),
  ).toThrow();
});
