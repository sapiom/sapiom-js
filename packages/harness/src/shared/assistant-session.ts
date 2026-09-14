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

/** Strict public lifecycle decoding; a descriptor never carries execution credentials. */
export function parseAssistantLifecycle(
  value: unknown,
): AssistantLifecycle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) =>
        ![
          "version",
          "harnessSessionId",
          "revision",
          "lifecycle",
          "execution",
          "updatedAt",
        ].includes(key),
    ) ||
    row.version !== 1 ||
    typeof row.harnessSessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(row.harnessSessionId) ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 0 ||
    !Number.isSafeInteger(row.updatedAt) ||
    (row.updatedAt as number) < 0 ||
    !["open", "ending", "ended"].includes(row.lifecycle as string) ||
    !["enabled", "paused"].includes(row.execution as string) ||
    (row.lifecycle !== "open" && row.execution !== "paused")
  )
    return null;
  return { ...row } as unknown as AssistantLifecycle;
}
