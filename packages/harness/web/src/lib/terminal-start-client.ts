import type { HarnessSession } from "@shared/types";
import { assistantSessionSchema } from "./assistant-resume-client";

/** Workspace and principal are immutable across activation of an existing Studio. */
export function sameStudioAuthority(
  source: HarnessSession,
  target: HarnessSession,
): boolean {
  return (
    source.cwd === target.cwd &&
    source.harness === target.harness &&
    (!source.agentMapIdentity ||
      (source.agentMapIdentity.sessionId === source.id &&
        target.agentMapIdentity?.sessionId === target.id &&
        target.agentMapIdentity.projectId ===
          source.agentMapIdentity.projectId &&
        target.agentMapIdentity.userId === source.agentMapIdentity.userId))
  );
}

export async function startTerminalRequest(
  source: HarnessSession,
  bootToken: string,
  signal: AbortSignal,
): Promise<HarnessSession> {
  const response = await fetch(
    "/api/sessions/" + encodeURIComponent(source.id) + "/terminal/start",
    {
      method: "POST",
      headers: {
        "X-Harness-Token": bootToken,
        "Content-Type": "application/json",
      },
      credentials: "omit",
      cache: "no-store",
      signal,
      body: "{}",
    },
  );
  if (!response.ok)
    throw new Error(
      "Terminal could not be started. This session is still available; try again.",
    );
  const result = assistantSessionSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (
    !result.success ||
    result.data.id !== source.id ||
    !sameStudioAuthority(source, result.data) ||
    result.data.agentMapIdentity?.sessionId !== source.id ||
    result.data.terminalState !== undefined
  )
    throw new Error(
      "Terminal start could not be verified. This session is still available.",
    );
  return result.data;
}
