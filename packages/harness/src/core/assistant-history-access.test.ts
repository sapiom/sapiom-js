import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assistantHistoryAccess } from "./assistant-history-access.js";
import { AssistantSessionStore } from "./assistant-session-store.js";
import {
  contextAuthorityScope,
  nativeAuthorityScope,
} from "./assistant-authority.js";
import type { AssistantGrant } from "./assistant-access.js";
import { AssistantHistory } from "./assistant-history.js";

const filesystem = vi.hoisted(() => ({
  afterRealpath: null as null | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const path = await actual.realpath(...args);
      await filesystem.afterRealpath?.();
      return path;
    },
  };
});

let root: string;
afterEach(async () => {
  filesystem.afterRealpath = null;
  if (root) await rm(root, { recursive: true, force: true });
});

it("resolves the host's same stable binding without native IO and rechecks authority after awaits", async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "assistant-history-access-")),
  );
  let grant: AssistantGrant | null = {
    userId: "u",
    tenantId: "t",
    identityRevision: "one",
    expiresAt: Date.now() + 60000,
    environment: {
      name: "test",
      apiURL: "https://api.example.test",
      appURL: "https://app.example.test",
      services: {},
      credentials: null,
    },
  };
  const store = new AssistantSessionStore(root);
  const workspace = { harnessSessionId: "studio-a", cwd: root };
  const key = {
    ...workspace,
    contextAuthorityScope: contextAuthorityScope(grant, workspace),
  };
  const saved = await store.associate(
    key,
    nativeAuthorityScope(grant, workspace),
    async () => "ses_original",
  );
  const authorize = vi.fn(async () => workspace);
  const resolve = assistantHistoryAccess({
    access: { get: () => grant },
    authorize,
    store,
  });
  expect(await resolve("studio-a")).toEqual(saved);
  let checks = 0;
  const checked = Object.assign(
    async (id: string) => {
      const binding = await resolve(id);
      checks++;
      return binding;
    },
    { captureAuthority: resolve.captureAuthority },
  );
  const session = {
    id: "studio-a",
    cwd: root,
    title: "Private saved title",
    harness: "claude-code" as const,
    status: "exited" as const,
    ready: false,
    agentSessionId: null,
    boundWorkflowPath: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    lastActiveAt: "2026-09-15T00:00:00.000Z",
  };
  const history = new AssistantHistory({
    sessions: { list: () => [session], get: () => session },
    authorize: checked,
    records: { read: async () => null },
    lifecycle: {
      describe: async () => ({
        version: 1,
        harnessSessionId: session.id,
        lifecycle: "ended",
        execution: "paused",
        revision: 1,
        updatedAt: 1,
      }),
    },
  });
  for (const action of ["entry", "list"] as const)
    for (const change of [
      "user",
      "tenant",
      "identity",
      "expire",
      "revoke",
      "refresh",
    ] as const) {
      const before: AssistantGrant = {
        ...grant!,
        environment: { ...grant!.environment },
      };
      checks = 0;
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      filesystem.afterRealpath = async () => {
        if (checks !== (action === "entry" ? 2 : 3)) return;
        filesystem.afterRealpath = null;
        enter();
        await held;
      };
      const pending =
        action === "entry"
          ? history.entry(session.id)
          : history.listWithWorkspace(root);
      await entered;
      if (change === "user") grant!.userId = "changed-user";
      if (change === "tenant") grant!.tenantId = "changed-tenant";
      if (change === "identity") grant!.identityRevision = "changed-revision";
      if (change === "expire") grant!.expiresAt = Date.now() - 1;
      if (change === "revoke") grant = null;
      if (change === "refresh")
        grant = { ...before, expiresAt: Date.now() + 120000 };
      release();
      if (change === "refresh") expect(await pending).toBeTruthy();
      else await expect(pending).rejects.toThrow("access changed");
      grant = before;
    }
  const alias = join(root, "alias"),
    other = join(root, "other");
  await symlink(root, alias, "junction");
  workspace.cwd = alias;
  expect(await resolve("studio-a")).toEqual(saved);
  const associate = store.associate.bind(store);
  for (const change of ["raw", "target"]) {
    vi.spyOn(store, "associate").mockImplementationOnce(async (...args) => {
      const binding = await associate(...args);
      if (change === "raw") workspace.cwd = root;
      else {
        await mkdir(other);
        await rm(alias);
        await symlink(other, alias, "junction");
      }
      return binding;
    });
    await expect(resolve("studio-a")).rejects.toThrow("access changed");
    workspace.cwd = alias;
  }
  workspace.cwd = root;
  authorize.mockImplementationOnce(async () => {
    grant = {
      ...grant!,
      expiresAt: Date.now() + 120000,
      environment: { ...grant!.environment },
    };
    return workspace;
  });
  expect(await resolve("studio-a")).toEqual(saved);
  for (const mutate of [
    () => {
      grant!.identityRevision = "two";
    },
    () => {
      grant!.userId = "another-user";
    },
    () => {
      grant!.environment.apiURL = "https://changed.example.test";
    },
    () => {
      grant!.expiresAt = Date.now() - 1;
    },
  ]) {
    const original: AssistantGrant = {
      ...grant!,
      environment: { ...grant!.environment },
    };
    authorize.mockImplementationOnce(async () => {
      mutate();
      return workspace;
    });
    await expect(resolve("studio-a")).rejects.toThrow("access changed");
    grant = original;
  }
  authorize
    .mockImplementationOnce(async () => workspace)
    .mockImplementationOnce(async () => ({ ...workspace, cwd: tmpdir() }));
  await expect(resolve("studio-a")).rejects.toThrow("access changed");
  authorize.mockImplementationOnce(async () => {
    grant = null;
    return workspace;
  });
  await expect(resolve("studio-a")).rejects.toThrow("access changed");
  await expect(resolve("studio-a")).rejects.toThrow("unavailable");
  expect(await store.association(key)).toEqual(saved);
});
