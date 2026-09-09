import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  createSapiomOpenCodeConfig,
  OpenCodeShutdownError,
  startOpenCodeServer,
  type OpenCodeServer,
} from "@sapiom/opencode";
import type { AssistantAccess, AssistantGrant } from "./assistant-access.js";
import { DurableFileLock } from "./durable-file-lock.js";
import type {
  OpenCodeBridge,
  OpenCodeBridgeCredential,
} from "../server/opencode-bridge.js";

export interface OpenCodeWorkspace {
  harnessSessionId: string;
  cwd: string;
}
export interface HostedOpenCode extends OpenCodeWorkspace {
  stateRoot: string;
  server: OpenCodeServer;
  signal: AbortSignal;
}
interface Managed {
  workspace: OpenCodeWorkspace;
  authority: string;
  abort: AbortController;
  ready?: Promise<HostedOpenCode>;
  credential?: OpenCodeBridgeCredential;
  unlock?: () => Promise<void>;
  cleanupFailed?: boolean;
}
interface Options {
  access: Pick<AssistantAccess, "get" | "subscribe">;
  bridge: Pick<OpenCodeBridge, "issue" | "model">;
  origin: () => string;
  stateRoot: string;
  authorize: (id: string) => Promise<OpenCodeWorkspace | null>;
  start?: typeof startOpenCodeServer;
}
export class OpenCodeAccessError extends Error {}
const authority = (grant: AssistantGrant) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        grant.identityRevision,
        grant.environment.name,
        grant.environment.apiURL,
        grant.environment.credentials?.apiKey,
      ]),
    )
    .digest("hex");

/** Owned by startServer, not by React mounts or browser connections. */
export class OpenCodeHost {
  private entries = new Map<string, Managed>();
  private closing = new Set<Promise<void>>();
  private closed = false;
  private cleanupFailed = false;
  private workspaceTimer: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  constructor(private readonly options: Options) {
    this.workspaceTimer = setInterval(() => {
      for (const [id, entry] of this.entries) {
        void this.workspace(id)
          .then(async (workspace) => {
            if (this.entries.get(id) !== entry) return;
            if (workspace.cwd !== entry.workspace.cwd) await this.retire(id);
          })
          .catch(() => {
            if (this.entries.get(id) === entry) void this.retire(id);
          });
      }
    }, 30000);
    this.workspaceTimer.unref?.();
    this.unsubscribe = options.access.subscribe(() => {
      const grant = options.access.get();
      for (const [id, entry] of this.entries) {
        if (!grant || authority(grant) !== entry.authority)
          void this.retire(id);
      }
    });
  }

  async ensure(id: string): Promise<HostedOpenCode> {
    const grant = this.options.access.get();
    if (this.closed || !grant)
      throw new OpenCodeAccessError("Assistant access is unavailable");
    const workspace = await this.workspace(id).catch(async (error) => {
      await this.retire(id);
      throw error;
    });
    const { cwd } = workspace;
    const current = this.options.access.get();
    if (this.closed || !current || authority(current) !== authority(grant))
      throw new OpenCodeAccessError("Assistant access changed. Please retry.");
    const existing = this.entries.get(id);
    if (
      existing &&
      existing.workspace.cwd === cwd &&
      existing.authority === authority(grant)
    )
      return existing.ready!;
    if (existing) await this.retire(id);
    // A prior retirement must finish before another process uses its database.
    await Promise.all(this.closing);
    const verified = await this.workspace(id);
    if (
      this.closed ||
      this.options.access.get() !== current ||
      verified.cwd !== cwd
    )
      return this.ensure(id);
    const racing = this.entries.get(id);
    if (racing) return this.ensure(id);
    const entry: Managed = {
      workspace: { harnessSessionId: id, cwd },
      authority: authority(grant),
      abort: new AbortController(),
    };
    this.entries.set(id, entry);
    entry.ready = this.start(entry, grant);
    return entry.ready;
  }

  retire(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    this.entries.delete(id);
    entry.abort.abort();
    entry.credential?.revoke();
    const closing = (async () => {
      const hosted = await entry.ready?.catch(() => null);
      try {
        await hosted?.server.close();
      } catch {
        entry.cleanupFailed = true;
      }
      // Keep the owner lock if shutdown fails, so another runtime cannot
      // concurrently use a database whose previous owner may still be alive.
      await this.unlock(entry);
    })();
    this.closing.add(closing);
    void closing.finally(() => this.closing.delete(closing)).catch(() => {});
    return closing;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.workspaceTimer);
    this.unsubscribe();
    for (const id of this.entries.keys()) void this.retire(id);
    const results = await Promise.allSettled(this.closing);
    if (
      this.cleanupFailed ||
      results.some((result) => result.status === "rejected")
    )
      throw new OpenCodeShutdownError();
  }

  private async workspace(id: string): Promise<OpenCodeWorkspace> {
    const workspace = await this.options.authorize(id);
    if (!workspace || workspace.harnessSessionId !== id)
      throw new OpenCodeAccessError("This Studio workspace is unavailable");
    return { harnessSessionId: id, cwd: await realpath(workspace.cwd) };
  }

  private async validate(entry: Managed): Promise<void> {
    const workspace = await this.workspace(entry.workspace.harnessSessionId);
    if (workspace.cwd !== entry.workspace.cwd)
      throw new OpenCodeAccessError(
        "This Studio workspace changed. Please retry.",
      );
    const grant = this.options.access.get();
    if (
      this.closed ||
      entry.abort.signal.aborted ||
      !grant ||
      authority(grant) !== entry.authority
    )
      throw new OpenCodeAccessError("Assistant access changed. Please retry.");
  }

  private async unlock(entry: Managed): Promise<void> {
    if (entry.cleanupFailed) {
      this.cleanupFailed = true;
      throw new OpenCodeShutdownError();
    }
    await entry.unlock?.();
    entry.unlock = undefined;
  }

  private async start(
    entry: Managed,
    grant: AssistantGrant,
  ): Promise<HostedOpenCode> {
    const scope = createHash("sha256")
      .update(
        JSON.stringify([
          grant.userId,
          grant.tenantId,
          entry.workspace.harnessSessionId,
          entry.workspace.cwd,
        ]),
      )
      .digest("hex");
    const stateRoot = join(this.options.stateRoot, "opencode", scope);
    let server: OpenCodeServer | undefined;
    try {
      entry.unlock = await new DurableFileLock(join(stateRoot, "runtime"), {
        timeoutMs: 1000,
        storageError: () =>
          new Error(
            "Assistant is already open in another Studio window or its state is unavailable",
          ),
      }).acquire();
      await this.validate(entry);
      entry.credential = this.options.bridge.issue();
      const config = createSapiomOpenCodeConfig({
        bridgeUrl: `${this.options.origin()}/opencode-runtime/${entry.credential.id}`,
        runtimeToken: entry.credential.token,
        model: this.options.bridge.model,
      });
      server = await (this.options.start ?? startOpenCodeServer)({
        cwd: entry.workspace.cwd,
        stateRoot: join(stateRoot, "engine"),
        config,
        signal: entry.abort.signal,
      });
      void server.exited
        .then(() => {
          if (this.entries.get(entry.workspace.harnessSessionId) === entry)
            return this.retire(entry.workspace.harnessSessionId);
        })
        .catch(() => {});
      await this.validate(entry);
      return {
        ...entry.workspace,
        stateRoot,
        server,
        signal: entry.abort.signal,
      };
    } catch (error) {
      if (this.entries.get(entry.workspace.harnessSessionId) === entry)
        this.entries.delete(entry.workspace.harnessSessionId);
      entry.credential?.revoke();
      if (error instanceof OpenCodeShutdownError) entry.cleanupFailed = true;
      if (server) {
        try {
          await server.close();
        } catch {
          entry.cleanupFailed = true;
        }
      }
      await this.unlock(entry);
      throw error;
    }
  }
}
