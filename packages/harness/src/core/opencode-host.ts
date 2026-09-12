import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  createSapiomOpenCodeConfig,
  OpenCodeShutdownError,
  startOpenCodeServer,
  type OpenCodeServer,
} from "@sapiom/opencode";
import type {
  AssistantAccess,
  AssistantAccessFailureCode,
  AssistantGrant,
  AssistantAccessProjection,
} from "./assistant-access.js";
import {
  openCodeStartupReasons,
  openCodeTransportFailure,
  type OpenCodeStartupReason,
  type OpenCodeTransportFailure,
} from "../shared/opencode-errors.js";
import {
  DurableFileLock,
  type DurableFileLockRelease,
} from "./durable-file-lock.js";
import type {
  OpenCodeBridge,
  OpenCodeBridgeCredential,
} from "../server/opencode-bridge.js";

import type { OpenCodeObserver } from "./opencode-observer.js";
import {
  isConversationId,
  type AssistantObservation,
  type AssistantSessionSummary,
  type AssistantStateSnapshot,
} from "../shared/assistant-state.js";

type ObserverHandle = Pick<OpenCodeObserver, "start" | "dispose">;
interface ObservationBinding {
  conversationId: string;
  observer?: ObserverHandle;
  failure?: OpenCodeTransportFailure;
}

export interface OpenCodeWorkspace {
  harnessSessionId: string;
  cwd: string;
}
export interface HostedOpenCode extends OpenCodeWorkspace {
  stateRoot: string;
  server: OpenCodeServer;
  signal: AbortSignal;
  isCurrent: () => boolean;
}
interface Managed {
  workspace: OpenCodeWorkspace;
  authority: string;
  abort: AbortController;
  ready?: Promise<HostedOpenCode>;
  hosted?: HostedOpenCode;
  observation?: ObservationBinding;
  credential?: OpenCodeBridgeCredential;
  unlock?: DurableFileLockRelease;
  cleanupFailed?: boolean;
}
interface Options {
  access: Pick<
    AssistantAccess,
    "get" | "getFailureCode" | "getBrowserState" | "subscribe"
  >;
  bridge: Pick<OpenCodeBridge, "issue" | "model">;
  origin: () => string;
  stateRoot: string;
  authorize: (id: string) => Promise<OpenCodeWorkspace | null>;
  start?: typeof startOpenCodeServer;
  createObserver: (
    hosted: HostedOpenCode,
    id: string,
    update: (state: AssistantObservation) => void,
  ) => ObserverHandle;
}
export class OpenCodeTransportError extends Error {
  constructor(readonly failure: OpenCodeTransportFailure) {
    super(failure.message);
  }
}
export class OpenCodeAccessError extends OpenCodeTransportError {
  constructor(
    message: string,
    code: AssistantAccessFailureCode = "access_denied",
  ) {
    const failure = openCodeTransportFailure(code);
    super(failure);
    this.message = message;
  }
}
const authority = (grant: AssistantGrant) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        grant.userId,
        grant.tenantId,
        grant.identityRevision,
        grant.environment.name,
        grant.environment.apiURL,
        grant.environment.credentials?.apiKey,
      ]),
    )
    .digest("hex");

/** Owned by startServer, not by React mounts or browser connections. */
export class OpenCodeHost {
  private readonly hostInstanceId = randomUUID();
  private assistantRevision = 0;
  private assistantAccess: AssistantAccessProjection;
  private readonly summaries = new Map<string, AssistantSessionSummary>();
  private readonly assistantListeners = new Set<() => void>();
  private entries = new Map<string, Managed>();
  private closing = new Set<Promise<void>>();
  private closed = false;
  private cleanupFailed = false;
  private workspaceTimer: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  constructor(private readonly options: Options) {
    this.assistantAccess = options.access.getBrowserState();
    this.workspaceTimer = setInterval(() => {
      for (const [id, entry] of this.entries) {
        void this.workspace(id)
          .then(async (workspace) => {
            if (this.entries.get(id) !== entry) return;
            if (workspace.cwd !== entry.workspace.cwd)
              await this.retire(id, openCodeTransportFailure("access_denied"));
          })
          .catch(() => {
            if (this.entries.get(id) === entry)
              void this.retire(id, openCodeTransportFailure("access_denied"));
          });
      }
    }, 30000);
    this.workspaceTimer.unref?.();
    this.unsubscribe = options.access.subscribe(() => {
      const grant = options.access.get();
      this.syncAssistantAccess();
      for (const [id, entry] of this.entries) {
        if (!grant || authority(grant) !== entry.authority)
          void this.retire(
            id,
            grant
              ? openCodeTransportFailure("access_denied")
              : this.accessFailure(),
          );
      }
    });
  }

  /** Read derived state only; never start or inspect an inactive native runtime. */
  getAssistantState(): AssistantStateSnapshot {
    this.syncAssistantAccess();
    return {
      hostInstanceId: this.hostInstanceId,
      authorityRevision: this.assistantAccess.authorityRevision,
      revision: this.assistantRevision,
      enabled: this.assistantAccess.enabled,
      sessions: [...this.summaries.values()].map((summary) => ({ ...summary })),
    };
  }
  subscribeAssistantState(listener: () => void): () => void {
    this.assistantListeners.add(listener);
    return () => {
      this.assistantListeners.delete(listener);
    };
  }
  private assistantChanged(): void {
    this.assistantRevision++;
    for (const listener of this.assistantListeners) {
      try {
        listener();
      } catch {
        /* Isolate state subscribers from runtime ownership. */
      }
    }
  }
  private syncAssistantAccess(): void {
    // getBrowserState can synchronously revoke access and reenter this owner.
    const projection = this.options.access.getBrowserState();
    const next = { ...projection, enabled: !this.closed && projection.enabled };
    if (
      next.enabled === this.assistantAccess.enabled &&
      next.authorityRevision === this.assistantAccess.authorityRevision
    )
      return;
    this.assistantAccess = next;
    this.summaries.clear();
    this.assistantChanged();
  }
  private removeSummary(id: string): void {
    if (this.summaries.delete(id)) this.assistantChanged();
  }
  observe(hosted: HostedOpenCode, conversationId: string): void {
    const id = hosted.harnessSessionId;
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.hosted !== hosted ||
      entry.abort.signal !== hosted.signal ||
      !hosted.isCurrent()
    ) {
      if (hosted.signal.reason instanceof OpenCodeTransportError)
        throw hosted.signal.reason;
      throw new OpenCodeTransportError(
        openCodeTransportFailure("transport_unavailable"),
      );
    }
    if (
      !isConversationId(conversationId) ||
      conversationId === id ||
      (entry.observation && entry.observation.conversationId !== conversationId)
    )
      throw new OpenCodeTransportError(
        openCodeTransportFailure("native_history_missing"),
      );
    if (entry.observation) {
      if (entry.observation.failure)
        throw new OpenCodeTransportError(entry.observation.failure);
      return;
    }
    const binding: ObservationBinding = { conversationId };
    entry.observation = binding;
    try {
      binding.observer = this.options.createObserver(
        hosted,
        conversationId,
        (state) => {
          if (
            this.entries.get(id) !== entry ||
            entry.hosted !== hosted ||
            entry.observation !== binding ||
            !hosted.isCurrent()
          )
            return;
          binding.failure =
            state.freshness === "unavailable" ? state.failure : undefined;
          const summary: AssistantSessionSummary = {
            harnessSessionId: id,
            conversationId,
            activity: state.activity,
            pendingPermissions: state.pendingPermissions,
            pendingQuestions: state.pendingQuestions,
            freshness: state.freshness,
            ...(state.failure ? { failure: state.failure } : {}),
          };
          if (
            JSON.stringify(this.summaries.get(id)) === JSON.stringify(summary)
          )
            return;
          this.summaries.set(id, summary);
          this.assistantChanged();
        },
      );
      binding.observer.start();
    } catch (error) {
      entry.observation = undefined;
      this.removeSummary(id);
      binding.observer?.dispose();
      throw error;
    }
  }

  async ensure(id: string): Promise<HostedOpenCode> {
    const grant = this.options.access.get();
    if (this.closed || !grant)
      throw this.accessError("Assistant access is unavailable");
    const workspace = await this.workspace(id).catch(async (error) => {
      await this.retire(
        id,
        error instanceof OpenCodeTransportError
          ? error.failure
          : openCodeTransportFailure("access_denied"),
      );
      throw error;
    });
    const { cwd } = workspace;
    const current = this.options.access.get();
    if (this.closed || !current || authority(current) !== authority(grant))
      throw new OpenCodeAccessError(
        "Assistant access changed. Please retry.",
        current ? "access_denied" : this.options.access.getFailureCode(),
      );
    const existing = this.entries.get(id);
    if (
      existing &&
      existing.workspace.cwd === cwd &&
      existing.authority === authority(grant)
    )
      return existing.ready!;
    if (existing)
      await this.retire(id, openCodeTransportFailure("access_denied"));
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

  retire(
    id: string,
    failure = openCodeTransportFailure("transport_unavailable"),
  ): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    this.entries.delete(id);
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
    // Own cleanup before removal notifies listeners that may reenter close().
    // The first await above defers native cleanup until this retirement is fenced.
    const binding = entry.observation;
    entry.observation = undefined;
    this.removeSummary(id);
    binding?.observer?.dispose();
    entry.abort.abort(new OpenCodeTransportError(failure));
    entry.credential?.revoke();
    return closing;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.syncAssistantAccess();
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
      throw new OpenCodeAccessError(
        "Assistant access changed. Please retry.",
        grant ? "access_denied" : this.options.access.getFailureCode(),
      );
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
    let startupAttempted = false;
    try {
      const release = await new DurableFileLock(join(stateRoot, "runtime"), {
        timeoutMs: 1000,
        processGuard: "required",
        storageError: () =>
          new Error(
            "Assistant is already open in another Studio window or its state is unavailable",
          ),
      }).acquire();
      entry.unlock = release;
      await this.validate(entry);
      entry.credential = this.options.bridge.issue();
      const config = createSapiomOpenCodeConfig({
        bridgeUrl: `${this.options.origin()}/opencode-runtime/${entry.credential.id}`,
        runtimeToken: entry.credential.token,
        model: this.options.bridge.model,
      });
      startupAttempted = true;
      server = await (this.options.start ?? startOpenCodeServer)({
        cwd: entry.workspace.cwd,
        stateRoot: join(stateRoot, "engine"),
        config,
        signal: entry.abort.signal,
        beforeLaunch: (identity) => release.protectProcess(identity),
      });
      void server.exited
        .then(() => {
          if (this.entries.get(entry.workspace.harnessSessionId) === entry)
            return this.retire(
              entry.workspace.harnessSessionId,
              openCodeTransportFailure("runtime_exited"),
            );
        })
        .catch(() => {});
      await this.validate(entry);
      const hosted: HostedOpenCode = {
        ...entry.workspace,
        stateRoot,
        server,
        signal: entry.abort.signal,
        isCurrent: () => {
          const current = this.options.access.get();
          return (
            !this.closed &&
            !entry.abort.signal.aborted &&
            this.entries.get(entry.workspace.harnessSessionId) === entry &&
            !!current &&
            authority(current) === entry.authority
          );
        },
      };
      entry.hosted = hosted;
      return hosted;
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
      if (error instanceof OpenCodeTransportError) throw error;
      if (
        entry.abort.signal.aborted &&
        entry.abort.signal.reason instanceof OpenCodeTransportError
      )
        throw entry.abort.signal.reason;
      throw new OpenCodeTransportError(
        startupAttempted
          ? openCodeTransportFailure(
              "runtime_start_failed",
              startupReason(error),
            )
          : openCodeTransportFailure("transport_unavailable"),
      );
    }
  }

  private accessFailure(): OpenCodeTransportFailure {
    return openCodeTransportFailure(this.options.access.getFailureCode());
  }

  private accessError(message: string): OpenCodeAccessError {
    return new OpenCodeAccessError(
      message,
      this.options.access.getFailureCode(),
    );
  }
}

function startupReason(error: unknown): OpenCodeStartupReason | undefined {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return openCodeStartupReasons.includes(code as OpenCodeStartupReason)
    ? (code as OpenCodeStartupReason)
    : undefined;
}
