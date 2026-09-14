import { realpath } from "node:fs/promises";
import type { ResolvedEnvironment } from "@sapiom/mcp/auth";
import type { HarnessSession, WorkflowInfo } from "../shared/types.js";
import type { HostedOpenCode } from "../core/opencode-host.js";
import type { StudioProjectIdentity } from "../core/studio-project-catalog.js";
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

import {
  createAssistantContextCandidate,
  retainAssistantGuidance,
  type ResolvedAssistantGuidance,
} from "../core/assistant-sources.js";
import type { ResolveAssistantCandidate } from "../core/studio-assistant-delivery.js";

interface Options {
  getSession: (id: string) => HarnessSession | undefined | null;
  getWorkflows: (signal?: AbortSignal) => Promise<WorkflowInfo[]>;
  getEnvironment: () => ResolvedEnvironment | null;
  resolveProject: (projectId: string) => Promise<StudioProjectIdentity | null>;
  loadSystemPrompt?: (signal?: AbortSignal) => Promise<string>;
  /** Epic 3 supplies connection/catalog facts, never a browser-provided list. */
  loadCapabilities?: (
    hosted: HostedOpenCode,
    signal: AbortSignal,
  ) => Promise<AssistantCapability[]>;
  /** Instruction/skill/lifecycle loaders receive already-resolved authority. */
  loadGuidance?: (
    context: StudioAssistantContext,
    hosted: HostedOpenCode,
    signal: AbortSignal,
  ) => Promise<AssistantGuidance[]>;
}

/** Preserve explicit missing-loader facts when another trusted source is appended. */
export function defaultAssistantGuidance(): AssistantGuidance[] {
  return [
    {
      id: "project-instructions",
      kind: "project",
      required: false,
      source: "host",
      revision: null,
      status: "not-configured",
      reason:
        "The trusted project instruction loader is not connected yet. Inspect applicable AGENTS.md (or CLAUDE.md fallback) before editing files.",
    },
    {
      id: "sapiom-agent-authoring",
      kind: "skill",
      required: false,
      source: "bundled",
      revision: null,
      status: "not-configured",
      reason:
        "The managed authoring skill loader is not connected yet. Use the installed SDK documentation; do not claim this skill was loaded.",
    },
  ];
}

async function currentCapabilities(
  hosted: HostedOpenCode,
  signal: AbortSignal,
): Promise<AssistantCapability[]> {
  const mcp = await hosted.server
    .fetchJson<Record<string, { status: string }>>("/mcp", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    })
    .catch(() => {
      signal.throwIfAborted();
      return {} as Record<string, { status: string }>;
    });
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
  return async (hosted, selectedAgentPath, admissionSignal = hosted.signal) => {
    const signal = AbortSignal.any([hosted.signal, admissionSignal]);
    signal.throwIfAborted();
    const current = options.getSession(hosted.harnessSessionId);
    const environment = options.getEnvironment();
    if (!current || !environment) throw assistantContextUnavailable();
    const identity = current.agentMapIdentity && {
      ...current.agentMapIdentity,
    };
    // Capture binding before any asynchronous provider can observe a rebind.
    const session = {
      id: current.id,
      cwd: current.cwd,
      projectId: current.agentMapIdentity?.projectId ?? null,
      boundAgentPath: current.boundWorkflowPath,
    };
    const projectAuthority = async () => {
      signal.throwIfAborted();
      const project = session.projectId
        ? await options.resolveProject(session.projectId).catch(() => null)
        : null;
      signal.throwIfAborted();
      const revision = project
        ? JSON.stringify([project.identityVersion, project.rootBindings])
        : null;
      const roots = await Promise.all(
        (project
          ? project.rootBindings
              .filter((root) => root.status === "active")
              .map((root) => root.localRootRef)
          : [hosted.cwd]
        ).map(async (path) => {
          const canonical = await realpath(path).catch(() => null);
          if (!canonical) throw assistantContextUnavailable();
          return canonical;
        }),
      );
      signal.throwIfAborted();
      const live = options.getSession(session.id);
      if (
        !live ||
        live.id !== session.id ||
        live.cwd !== session.cwd ||
        live.agentMapIdentity?.projectId !== identity?.projectId ||
        live.agentMapIdentity?.userId !== identity?.userId ||
        live.agentMapIdentity?.sessionId !== identity?.sessionId ||
        (session.projectId && project?.projectId !== session.projectId)
      )
        throw assistantContextUnavailable();
      return { roots: roots.sort(), revision };
    };
    const authority = await projectAuthority();
    const [workflows, profile, capabilities] = await Promise.all([
      options.getWorkflows(signal),
      assistantProfile(environment, options.loadSystemPrompt, signal),
      (options.loadCapabilities ?? currentCapabilities)(hosted, signal),
    ]);
    signal.throwIfAborted();
    const context = await resolveStudioAssistantContext({
      hosted,
      session,
      selectedAgentPath,
      projectRoots: authority.roots,
      workflows,
      environment: environment.name,
      capabilities,
      guidance: [
        profile,
        ...(session.projectId ? [assistantProjectRole()] : []),
      ],
    });
    signal.throwIfAborted();
    const sources = options.loadGuidance
      ? await options.loadGuidance(context, hosted, signal)
      : defaultAssistantGuidance();
    if (
      JSON.stringify(await projectAuthority()) !== JSON.stringify(authority) ||
      !hosted.isCurrent() ||
      hosted.signal.aborted
    )
      throw assistantContextUnavailable();
    signal.throwIfAborted();
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

/** The typed provider seam retains exact supplied material; acquisition remains with sibling loaders. */
export function createAssistantContextCandidateResolver(
  options: Omit<Options, "loadGuidance"> & {
    loadGuidance?: (
      context: StudioAssistantContext,
      hosted: HostedOpenCode,
      signal: AbortSignal,
    ) => Promise<ResolvedAssistantGuidance[]>;
  },
): ResolveAssistantCandidate {
  const { loadGuidance, ...base } = options;
  return async (hosted, selection, admissionSignal) => {
    const signal = AbortSignal.any([hosted.signal, admissionSignal]);
    let extra: ResolvedAssistantGuidance[] = [];
    const resolve = createAssistantContextResolver({
      ...base,
      ...(loadGuidance
        ? {
            loadGuidance: async (context, current, signal) => {
              extra = await loadGuidance(context, current, signal);
              return [];
            },
          }
        : {}),
    });
    const context = await resolve(hosted, selection, signal);
    signal.throwIfAborted();
    if (!hosted.isCurrent()) throw assistantContextUnavailable();
    const guidance = [
      ...context.guidance.map((source) =>
        retainAssistantGuidance(source, hosted.contextAuthorityScope),
      ),
      ...extra,
    ];
    const resolved = {
      ...context,
      guidance: [
        ...context.guidance,
        ...extra.map((source) => source.metadata),
      ],
    };
    resolved.revision = assistantContextDigest(
      JSON.stringify({ ...resolved, revision: undefined }),
    );
    return createAssistantContextCandidate(
      resolved,
      hosted.contextAuthorityScope,
      guidance,
    );
  };
}
