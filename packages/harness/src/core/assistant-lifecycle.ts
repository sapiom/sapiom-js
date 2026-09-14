import { randomUUID } from "node:crypto";
import type { AssistantLifecycle } from "../shared/assistant-session.js";
import { openCodeTransportFailure } from "../shared/opencode-errors.js";
import {
  AssistantSessionRevisionError,
  type AssistantSessionStore,
} from "./assistant-session-store.js";
import {
  OpenCodeTransportError,
  type HostedOpenCode,
  type OpenCodeHost,
} from "./opencode-host.js";
import type { OpenCodeAssociations } from "./opencode-association.js";

export interface AssistantAttachment {
  conversationId: string;
  lease: string;
  lifecycle: AssistantLifecycle;
}
interface Lease extends AssistantAttachment {
  hosted: HostedOpenCode;
}
export interface AssistantEndFence {
  readonly id: string;
  readonly generation: number;
}
interface Options {
  store: Pick<AssistantSessionStore, "lifecycle" | "transition">;
  host: Pick<
    OpenCodeHost,
    | "ensure"
    | "current"
    | "assertCurrent"
    | "retireExact"
    | "retireWithResult"
    | "observe"
    | "beginShutdown"
  >;
  associations: Pick<OpenCodeAssociations, "ensure">;
}
const failure = (
  code: "lifecycle_changed" | "session_ended" | "execution_paused",
) => new OpenCodeTransportError(openCodeTransportFailure(code));
const initial = (id: string): AssistantLifecycle => ({
  version: 1,
  harnessSessionId: id,
  revision: 0,
  lifecycle: "open",
  execution: "paused",
  updatedAt: 0,
});

/** Server-owned admission. Reading or detaching a pane never obtains a runtime lease. */
export class AssistantLifecycleCoordinator {
  private readonly leases = new Map<string, Lease>();
  private readonly states = new Map<string, AssistantLifecycle>();
  private readonly generations = new Map<string, number>();
  private readonly ending = new Set<string>();
  private readonly pending = new Map<
    string,
    { revision: number; promise: Promise<AssistantAttachment> }
  >();
  private readonly listeners = new Set<() => void>();
  private closed = false;
  constructor(private readonly options: Options) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Isolate UI subscribers. */
      }
    }
  }
  private remember(state: AssistantLifecycle): void {
    const previous = this.states.get(state.harnessSessionId);
    if (previous && previous.revision >= state.revision) return;
    this.states.set(state.harnessSessionId, state);
    this.changed();
  }
  private generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }
  private check(fence: AssistantEndFence, ending = false): void {
    if (
      this.closed ||
      this.generation(fence.id) !== fence.generation ||
      (!ending && this.ending.has(fence.id))
    )
      throw failure("lifecycle_changed");
  }
  private view(state: AssistantLifecycle): AssistantLifecycle {
    const id = state.harnessSessionId;
    const lease = this.leases.get(id);
    return {
      ...state,
      lifecycle: this.ending.has(id) ? "ending" : state.lifecycle,
      execution:
        state.lifecycle === "open" &&
        lease?.lifecycle.revision === state.revision &&
        !this.closed &&
        !this.ending.has(id) &&
        lease?.hosted.isCurrent()
          ? lease.lifecycle.execution
          : "paused",
    };
  }
  snapshot(): AssistantLifecycle[] {
    return [...this.states.values()].map((state) => this.view(state));
  }
  async describe(id: string): Promise<AssistantLifecycle> {
    const state = (await this.options.store.lifecycle(id)) ?? initial(id);
    this.remember(state);
    return this.view(this.states.get(id) ?? state);
  }

  attach(id: string, expectedRevision: number): Promise<AssistantAttachment> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      return Promise.reject(failure("lifecycle_changed"));
    const pending = this.pending.get(id);
    if (pending)
      return pending.revision === expectedRevision
        ? pending.promise
        : Promise.reject(failure("lifecycle_changed"));
    const fence = { id, generation: this.generation(id) };
    const promise = this.open(fence, expectedRevision).finally(() => {
      if (this.pending.get(id)?.promise === promise) this.pending.delete(id);
    });
    this.pending.set(id, { revision: expectedRevision, promise });
    return promise;
  }
  private async open(
    fence: AssistantEndFence,
    expectedRevision: number,
  ): Promise<AssistantAttachment> {
    const { id } = fence;
    this.check(fence);
    const state = await this.describe(id);
    this.check(fence);
    if (state.revision !== expectedRevision) throw failure("lifecycle_changed");
    if (state.lifecycle !== "open") throw failure("session_ended");
    const previous = this.leases.get(id);
    if (previous?.hosted === this.options.host.current(id)) {
      await this.assertRuntime(previous.hosted);
      return this.publicLease(previous);
    }
    const existing = this.options.host.current(id);
    let hosted: HostedOpenCode | undefined;
    try {
      hosted = await this.options.host.ensure(id);
      this.check(fence);
      const conversationId = await this.options.associations.ensure(hosted);
      this.check(fence);
      await this.options.host.assertCurrent(hosted);
      this.check(fence);
      // Every restarted runtime begins paused, irrespective of the last process's saved admission.
      const lifecycle = await this.options.store.transition(
        id,
        expectedRevision,
        { lifecycle: "open", execution: "paused" },
        hosted.signal,
      );
      this.check(fence);
      await this.options.host.assertCurrent(hosted);
      this.check(fence);
      const lease: Lease = {
        hosted,
        conversationId,
        lease: randomUUID(),
        lifecycle,
      };
      this.leases.set(id, lease);
      this.remember(lifecycle);
      this.options.host.observe(hosted, conversationId);
      return this.publicLease(lease);
    } catch (error) {
      if (hosted && hosted !== existing)
        void this.options.host.retireExact(hosted).catch(() => {});
      throw error instanceof AssistantSessionRevisionError
        ? failure("lifecycle_changed")
        : error;
    }
  }
  private publicLease({
    conversationId,
    lease,
    lifecycle,
  }: Lease): AssistantAttachment {
    return { conversationId, lease, lifecycle: { ...lifecycle } };
  }

  /** Exact token + exact host + durable revision; this path never calls ensure(). */
  async use(
    id: string,
    token: string | undefined,
    execution = false,
  ): Promise<Lease> {
    const lease = this.leases.get(id);
    if (!token || lease?.lease !== token) throw failure("lifecycle_changed");
    await this.assertRuntime(lease.hosted, execution);
    return lease;
  }
  async assertRuntime(
    hosted: HostedOpenCode,
    execution = false,
  ): Promise<void> {
    const id = hosted.harnessSessionId;
    const lease = this.leases.get(id);
    const fence = { id, generation: this.generation(id) };
    const check = () => {
      this.check(fence);
      if (
        !lease ||
        this.leases.get(id) !== lease ||
        lease.hosted !== hosted ||
        !hosted.isCurrent()
      )
        throw failure("lifecycle_changed");
      if (execution && lease.lifecycle.execution !== "enabled")
        throw failure("execution_paused");
    };
    check();
    await this.options.host.assertCurrent(hosted);
    check();
    const saved = await this.options.store.lifecycle(id);
    check();
    if (
      !saved ||
      saved.revision !== lease!.lifecycle.revision ||
      saved.lifecycle !== "open"
    )
      throw failure("lifecycle_changed");
  }

  /** Called inside the existing dispatch admission, after explicit user context preparation. */
  async enable(hosted: HostedOpenCode): Promise<void> {
    await this.assertRuntime(hosted);
    const id = hosted.harnessSessionId;
    const lease = this.leases.get(id)!;
    if (lease.lifecycle.execution === "enabled") return;
    const fence = { id, generation: this.generation(id) };
    const state = await this.options.store.transition(
      id,
      lease.lifecycle.revision,
      { lifecycle: "open", execution: "enabled" },
      hosted.signal,
    );
    this.check(fence);
    if (this.leases.get(id) !== lease) throw failure("lifecycle_changed");
    lease.lifecycle = state;
    this.remember(state);
  }

  /** Fences execution and requests process termination before any persistence await.
   * The End orchestration owner must coalesce callers through its complete
   * Terminal/native/persistence operation, including finishEnd or failure reporting. */
  beginEnd(id: string) {
    const fence = { id, generation: this.generation(id) + 1 };
    this.generations.set(id, fence.generation);
    this.ending.add(id);
    this.leases.delete(id);
    this.pending.delete(id);
    const native = this.options.host.retireWithResult(id);
    const persistence = this.persistEnd(fence, "ending");
    this.changed();
    return { fence, native, persistence };
  }
  async finishEnd(fence: AssistantEndFence): Promise<AssistantLifecycle> {
    const state = await this.persistEnd(fence, "ended");
    this.check(fence, true);
    this.ending.delete(fence.id);
    this.changed();
    return state;
  }
  private async persistEnd(
    fence: AssistantEndFence,
    lifecycle: "ending" | "ended",
  ): Promise<AssistantLifecycle> {
    for (let attempt = 0; attempt < 4; attempt++) {
      this.check(fence, true);
      const state = await this.options.store.lifecycle(fence.id);
      this.check(fence, true);
      try {
        const next = await this.options.store.transition(
          fence.id,
          state?.revision ?? 0,
          { lifecycle, execution: "paused" },
        );
        this.check(fence, true);
        this.remember(next);
        return next;
      } catch (error) {
        if (!(error instanceof AssistantSessionRevisionError)) throw error;
      }
    }
    throw failure("lifecycle_changed");
  }
  beginShutdown(): void {
    this.closed = true;
    this.leases.clear();
    this.options.host.beginShutdown();
    this.changed();
  }
}
