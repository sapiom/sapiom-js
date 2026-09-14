export interface AssistantLifecycle {
  version: 1;
  harnessSessionId: string;
  revision: number;
  lifecycle: "open" | "ending" | "ended";
  execution: "enabled" | "paused";
  updatedAt: number;
}

export interface AssistantSessionView extends Omit<
  AssistantLifecycle,
  "version" | "updatedAt"
> {
  history: "available" | "partial" | "missing" | "unavailable";
  nativeResume: "unchecked" | "available" | "missing" | "unavailable";
}
