import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assistantHistoryAccess } from "./assistant-history-access.js";
import { AssistantSessionStore } from "./assistant-session-store.js";
import {
  contextAuthorityScope,
  nativeAuthorityScope,
} from "./assistant-authority.js";
import type { AssistantGrant } from "./assistant-access.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("resolves the host's same stable binding without native IO and rechecks authority after awaits", async () => {
  root = await mkdtemp(join(tmpdir(), "assistant-history-access-"));
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
  authorize.mockImplementationOnce(async () => {
    grant = null;
    return workspace;
  });
  await expect(resolve("studio-a")).rejects.toThrow("access changed");
  await expect(resolve("studio-a")).rejects.toThrow("unavailable");
  expect(await store.association(key)).toEqual(saved);
});
