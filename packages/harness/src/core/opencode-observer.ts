import { setTimeout as delay } from "node:timers/promises";
import type { HostedOpenCode } from "./opencode-host.js";
import { readOpenCodeEvents } from "../server/opencode-events.js";
import type { AssistantObservation } from "../shared/assistant-state.js";
import {
  openCodeTransportFailure,
  parseOpenCodeTransportFailure,
  type OpenCodeTransportFailure,
} from "../shared/opencode-errors.js";

type Kind = "permission" | "question";
type Resource = Kind | "status" | "session";
interface Connection {
  abort: AbortController;
  current: Set<Resource>;
  statusRevision: number;
  updates: Record<Kind, Map<string, boolean> | null>;
}
const resources: Resource[] = ["session", "status", "permission", "question"];
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const activity = (value: unknown): AssistantObservation["activity"] | null =>
  value === "idle" || value === "busy" || value === "retry" ? value : null;

/** Observe one authorized association. Construction and getters perform no I/O. */
export class OpenCodeObserver {
  private readonly lifetime = new AbortController();
  private connection?: Connection;
  private started = false;
  private disposed = false;
  private readonly pending = {
    permission: new Set<string>(),
    question: new Set<string>(),
  };
  private readonly known = { permission: false, question: false };
  private value: AssistantObservation = {
    activity: "unknown",
    pendingPermissions: null,
    pendingQuestions: null,
    freshness: "connecting",
  };
  constructor(
    private readonly hosted: HostedOpenCode,
    private readonly id: string,
    private readonly onUpdate: (state: AssistantObservation) => void,
  ) {}

  getState(): AssistantObservation {
    return { ...this.value };
  }
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.hosted.signal.addEventListener("abort", this.dispose, { once: true });
    if (!this.live()) {
      this.dispose();
      return;
    }
    this.onUpdate(this.getState());
    void this.run();
  }
  dispose = (): void => {
    this.disposed = true;
    this.hosted.signal.removeEventListener("abort", this.dispose);
    this.lifetime.abort();
    this.connection?.abort.abort();
  };
  private live(c?: Connection): boolean {
    return (
      !this.disposed &&
      !this.hosted.signal.aborted &&
      this.hosted.isCurrent() &&
      (!c || (this.connection === c && !c.abort.signal.aborted))
    );
  }
  private update(next: Partial<AssistantObservation>): void {
    const value = { ...this.value, ...next };
    if (JSON.stringify(value) === JSON.stringify(this.value)) return;
    this.value = value;
    this.onUpdate(this.getState());
  }
  private accepted(
    c: Connection,
    next: Partial<AssistantObservation> = {},
  ): void {
    if (!this.live(c)) return;
    this.update({
      ...next,
      ...(c.current.size === resources.length
        ? { freshness: "current", failure: undefined }
        : {}),
    });
  }
  private fail(failure: OpenCodeTransportFailure): void {
    this.update({ freshness: "unavailable", failure });
    this.dispose();
  }
  private counts(): Pick<
    AssistantObservation,
    "pendingPermissions" | "pendingQuestions"
  > {
    return {
      pendingPermissions: this.known.permission
        ? this.pending.permission.size
        : null,
      pendingQuestions: this.known.question ? this.pending.question.size : null,
    };
  }
  private async run(): Promise<void> {
    let backoff = 250;
    while (this.live()) {
      const c: Connection = {
        abort: new AbortController(),
        current: new Set(),
        statusRevision: 0,
        updates: { permission: null, question: null },
      };
      this.connection = c;
      const signal = AbortSignal.any([this.lifetime.signal, c.abort.signal]);
      const openedAt = Date.now();
      try {
        for await (const event of readOpenCodeEvents(
          this.hosted,
          this.id,
          signal,
          () => {
            void this.reconcile(c).catch(() => {});
          },
        )) {
          if (!this.live(c)) break;
          this.event(c, event);
        }
      } catch {
        /* Loss of observation is not execution failure. */
      } finally {
        c.abort.abort();
        if (this.connection === c) this.connection = undefined;
      }
      if (!this.live()) return;
      this.update({
        freshness: "reconnecting",
        failure: openCodeTransportFailure("transport_unavailable"),
      });
      if (Date.now() - openedAt >= 5000) backoff = 250;
      await delay(backoff, undefined, {
        signal: this.lifetime.signal,
        ref: false,
      }).catch(() => {});
      backoff = Math.min(backoff * 2, 5000);
    }
  }
  private async reconcile(c: Connection): Promise<void> {
    let backoff = 250;
    while (this.live(c) && c.current.size !== resources.length) {
      await Promise.all(
        resources
          .filter((resource) => !c.current.has(resource))
          .map((resource) =>
            this.read(c, resource).catch(() => {
              if (this.live(c) && !c.current.has(resource))
                this.update({
                  freshness: "reconnecting",
                  failure: openCodeTransportFailure("transport_unavailable"),
                });
            }),
          ),
      );
      if (!this.live(c) || c.current.size === resources.length) return;
      await delay(backoff, undefined, { signal: c.abort.signal, ref: false });
      backoff = Math.min(backoff * 2, 5000);
    }
  }
  private async read(c: Connection, resource: Resource): Promise<void> {
    const revision = c.statusRevision;
    const updates = new Map<string, boolean>();
    if (resource === "permission" || resource === "question")
      c.updates[resource] = updates;
    const signal = AbortSignal.any([
      c.abort.signal,
      this.lifetime.signal,
      AbortSignal.timeout(3000),
    ]);
    try {
      const path =
        resource === "session"
          ? `/session/${this.id}`
          : resource === "status"
            ? "/session/status"
            : `/${resource}`;
      const response = await this.hosted.server.fetch(path, { signal });
      if (!response.ok) {
        await response.body?.cancel();
        if (this.live(c) && resource === "session" && response.status === 404)
          this.fail(openCodeTransportFailure("native_history_missing"));
        throw new Error("Assistant observation read failed");
      }
      if (!this.live(c) || signal.aborted) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      const value: unknown = await response.json();
      if (!this.live(c) || signal.aborted) return;
      if (resource === "session") {
        if (record(value)?.id !== this.id)
          throw new Error("Invalid conversation metadata");
      } else if (resource === "status") {
        if (revision !== c.statusRevision) return;
        const statuses = record(value);
        if (!statuses) throw new Error("Invalid conversation status");
        const next =
          statuses[this.id] === undefined
            ? "idle"
            : activity(record(statuses[this.id])?.type);
        if (!next) throw new Error("Invalid conversation status");
        c.current.add(resource);
        this.accepted(c, { activity: next });
        return;
      } else {
        if (!Array.isArray(value)) throw new Error("Invalid pending requests");
        const ids = new Set<string>();
        const allIds = new Set<string>();
        for (const entry of value) {
          const request = record(entry);
          if (
            !request ||
            !identifier(request.id) ||
            !identifier(request.sessionID) ||
            allIds.has(request.id)
          )
            throw new Error("Invalid pending request identity");
          allIds.add(request.id);
          if (request.sessionID === this.id) ids.add(request.id);
        }
        for (const [id, pending] of updates) {
          if (pending) ids.add(id);
          else ids.delete(id);
        }
        this.pending[resource] = ids;
        this.known[resource] = true;
      }
      c.current.add(resource);
      this.accepted(c, this.counts());
    } finally {
      if (
        (resource === "permission" || resource === "question") &&
        c.updates[resource] === updates
      )
        c.updates[resource] = null;
    }
  }
  private event(c: Connection, event: Record<string, unknown>): void {
    const properties = record(event.properties) ?? {};
    if (event.type === "session.deleted") {
      this.fail(openCodeTransportFailure("native_history_missing"));
      return;
    }
    if (event.type === "studio.error") {
      const failure = parseOpenCodeTransportFailure(properties);
      if (failure) this.fail(failure);
      return;
    }
    const next =
      event.type === "session.idle"
        ? "idle"
        : event.type === "session.status"
          ? activity(record(properties.status)?.type)
          : null;
    if (next) {
      c.statusRevision++;
      c.current.add("status");
      this.accepted(c, { activity: next });
    }
    for (const kind of ["permission", "question"] as const) {
      const asked = event.type === `${kind}.asked`;
      if (
        !asked &&
        event.type !== `${kind}.replied` &&
        !(kind === "question" && event.type === "question.rejected")
      )
        continue;
      const id = asked ? properties.id : properties.requestID;
      if (!identifier(id)) continue;
      if (asked) this.pending[kind].add(id);
      else this.pending[kind].delete(id);
      c.updates[kind]?.set(id, asked);
      this.accepted(c, this.counts());
    }
  }
}
