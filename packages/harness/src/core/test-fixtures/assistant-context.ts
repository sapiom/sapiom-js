import type { StudioAssistantContext } from "../studio-assistant-context.js";
import {
  createAssistantContextCandidate,
  acceptedAssistantRecord,
} from "../assistant-sources.js";

export const sourceScope = "a".repeat(64);
export const acceptanceId = "11111111-1111-4111-8111-111111111111";
export function sourceContext(): StudioAssistantContext {
  return {
    schemaVersion: 1,
    revision: "resolver-snapshot",
    session: { id: "studio-a", cwd: "/workspace", projectId: null },
    environment: "test",
    selectedAgent: { status: "none" },
    boundAgent: { status: "not-provided" },
    agents: [],
    capabilities: [{ name: "sapiom", status: "available", tools: ["read"] }],
    guidance: [
      {
        id: "profile",
        kind: "profile",
        required: true,
        source: "fixture:profile",
        revision: "old-label",
        status: "available",
        text: "Exact profile\r\nbytes",
      },
    ],
  };
}
export function sourceFixture() {
  const candidate = createAssistantContextCandidate(
    sourceContext(),
    sourceScope,
  );
  return {
    candidate,
    accepted: acceptedAssistantRecord(
      candidate,
      sourceScope,
      "ses_fixture",
      acceptanceId,
    ),
    authority: { authorityScope: sourceScope, conversationId: "ses_fixture" },
  };
}
