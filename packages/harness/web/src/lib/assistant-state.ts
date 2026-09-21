import {
  parseAssistantState,
  type AssistantStateSnapshot,
} from "@shared/assistant-state";

export interface AssistantProjection {
  snapshot: AssistantStateSnapshot | null;
  current: boolean;
}
export interface EventConnection {
  generation: number;
  phase: "connecting" | "open" | "closed";
}

/** One ordering domain for boot reads, socket lifetimes and auth barriers. */
export class AssistantStateOrder {
  private value: AssistantProjection = { snapshot: null, current: false };
  private last: AssistantStateSnapshot | null = null;
  private connection: EventConnection = { generation: 0, phase: "closed" };
  private initialized = false;
  private socketAuthority = false;
  private authGeneration = 0;
  private request = 0;

  current(): AssistantProjection {
    return this.value;
  }
  beginHttp(): { auth: number; request: number } {
    return { auth: this.authGeneration, request: ++this.request };
  }
  http(
    token: ReturnType<AssistantStateOrder["beginHttp"]>,
    raw: unknown,
  ): AssistantProjection {
    if (
      this.socketAuthority ||
      token.auth !== this.authGeneration ||
      token.request !== this.request
    )
      return this.value;
    const snapshot = parseAssistantState(raw);
    if (!snapshot || !this.accepts(snapshot)) return this.value;
    this.last = snapshot;
    return (this.value = { snapshot, current: false });
  }
  transport(connection: EventConnection): AssistantProjection {
    if (connection.generation < this.connection.generation) return this.value;
    if (connection.generation !== this.connection.generation)
      this.initialized = false;
    this.connection = connection;
    return (this.value = { ...this.value, current: false });
  }
  socket(generation: number | undefined, raw: unknown): AssistantProjection {
    if (
      generation !== this.connection.generation ||
      this.connection.phase !== "open"
    )
      return this.value;
    const snapshot = parseAssistantState(raw);
    if (!snapshot) return (this.value = { ...this.value, current: false });
    if (
      (this.initialized &&
        snapshot.hostInstanceId !== this.last?.hostInstanceId) ||
      !this.accepts(snapshot)
    )
      return this.value;
    this.initialized = this.socketAuthority = true;
    this.last = snapshot;
    return (this.value = { snapshot, current: true });
  }
  authChanged(): AssistantProjection {
    this.authGeneration++;
    return (this.value = { snapshot: null, current: false });
  }
  private accepts(snapshot: AssistantStateSnapshot): boolean {
    return !(
      this.last?.hostInstanceId === snapshot.hostInstanceId &&
      snapshot.revision < this.last.revision
    );
  }
}
