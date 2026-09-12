import type { ResolvedEnvironment } from "@sapiom/mcp/auth";
import type { HarnessSession, WorkflowInfo } from "../shared/types.js";
import type { HostedOpenCode } from "../core/opencode-host.js";
import {
  assistantContextDigest,
  assistantContextUnavailable,
  resolveStudioAssistantContext,
  type AssistantCapability,
  type AssistantGuidance,
  type ResolveAssistantContext,
  type StudioAssistantContext,
} from "../core/studio-assistant-context.js";
import {
  assistantProfile,
  assistantProjectRole,
} from "../profiles/assistant.js";

interface Options {
  getSession: (id: string) => HarnessSession | undefined | null;
  getWorkflows: () => Promise<WorkflowInfo[]>;
  getEnvironment: () => ResolvedEnvironment | null;
  loadSystemPrompt?: () => Promise<string>;
  /** Epic 3 supplies connection/catalog facts, never a browser-provided list. */
  loadCapabilities?: (hosted: HostedOpenCode) => Promise<AssistantCapability[]>;
  /** Instruction/skill/lifecycle loaders receive already-resolved authority. */
  loadGuidance?: (
    context: StudioAssistantContext,
    hosted: HostedOpenCode,
  ) => Promise<AssistantGuidance[]>;
}

async function currentCapabilities(
  hosted: HostedOpenCode,
): Promise<AssistantCapability[]> {
  const mcp = await hosted.server
    .fetchJson<Record<string, { status: string }>>("/mcp", {
      signal: AbortSignal.any([hosted.signal, AbortSignal.timeout(5000)]),
    })
    .catch(() => ({}) as Record<string, { status: string }>);
  return [
    {
      name: "sapiom",
      status:
        mcp.sapiom?.status === "connected"
          ? "available"
          : mcp.sapiom
            ? "unavailable"
            : "configured",
      tools: [],
    },
    { name: "sapiom-dev", status: "unavailable", tools: [] },
    { name: "agent-map", status: "unavailable", tools: [] },
  ];
}

export function createAssistantContextResolver(
  options: Options,
): ResolveAssistantContext {
  return async (hosted, selectedAgentPath) => {
    const current = options.getSession(hosted.harnessSessionId);
    const environment = options.getEnvironment();
    if (!current || !environment) throw assistantContextUnavailable();
    // Capture binding before any asynchronous provider can observe a rebind.
    const session = {
      id: current.id,
      cwd: current.cwd,
      projectId: current.agentMapIdentity?.projectId ?? null,
      boundAgentPath: current.boundWorkflowPath,
    };
    const [workflows, profile, capabilities] = await Promise.all([
      options.getWorkflows(),
      assistantProfile(environment, options.loadSystemPrompt),
      (options.loadCapabilities ?? currentCapabilities)(hosted),
    ]);
    const context = await resolveStudioAssistantContext({
      hosted,
      session,
      selectedAgentPath,
      workflows,
      environment: environment.name,
      capabilities,
      guidance: [
        profile,
        ...(session.projectId ? [assistantProjectRole()] : []),
      ],
    });
    const sources = options.loadGuidance
      ? await options.loadGuidance(context, hosted)
      : [
          {
            id: "project-instructions",
            kind: "project" as const,
            required: false,
            source: "host",
            revision: null,
            status: "not-configured" as const,
            reason:
              "The trusted project instruction loader is not connected yet. Inspect applicable AGENTS.md (or CLAUDE.md fallback) before editing files.",
          },
          {
            id: "sapiom-agent-authoring",
            kind: "skill" as const,
            required: false,
            source: "bundled",
            revision: null,
            status: "not-configured" as const,
            reason:
              "The managed authoring skill loader is not connected yet. Use the installed SDK documentation; do not claim this skill was loaded.",
          },
        ];
    if (!hosted.isCurrent() || hosted.signal.aborted)
      throw assistantContextUnavailable();
    const serialized = JSON.stringify({
      ...context,
      revision: undefined,
      guidance: [...context.guidance, ...sources],
    });
    return {
      ...JSON.parse(serialized),
      revision: assistantContextDigest(serialized),
    };
  };
}
