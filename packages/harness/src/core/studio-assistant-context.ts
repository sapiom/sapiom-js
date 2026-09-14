import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { WorkflowInfo } from "../shared/types.js";
import type { HostedOpenCode } from "./opencode-host.js";
import { OpenCodeTransportError } from "./opencode-host.js";
import { openCodeTransportFailure } from "../shared/opencode-errors.js";
import { openCodeCompletionPrompt } from "../shared/opencode-completion.js";

export interface AssistantContextAgent {
  name: string;
  path: string;
  definitionId: number | null;
}
export type AssistantAgentContext =
  | { status: "available"; agent: AssistantContextAgent }
  | { status: "none" | "not-provided" }
  | { status: "unavailable"; path: string };

/** Providers return data; only this module composes native instructions. */
export interface AssistantGuidance {
  id: string;
  kind: "profile" | "project" | "skill" | "continuation";
  required: boolean;
  source: string;
  scope?: string;
  revision: string | null;
  status: "available" | "unavailable" | "not-configured";
  text?: string;
  location?: string;
  reason?: string;
}
export interface AssistantCapability {
  name: string;
  status: "available" | "configured" | "unavailable";
  tools: string[];
}
export interface StudioAssistantContext {
  schemaVersion: 1;
  revision: string;
  session: { id: string; cwd: string; projectId: string | null };
  environment: string;
  selectedAgent: AssistantAgentContext;
  boundAgent: AssistantAgentContext;
  agents: AssistantContextAgent[];
  capabilities: AssistantCapability[];
  guidance: AssistantGuidance[];
}
export type ResolveAssistantContext = (
  hosted: HostedOpenCode,
  selectedAgentPath?: string | null,
) => Promise<StudioAssistantContext>;

export const assistantContextDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export function assistantContextUnavailable(): OpenCodeTransportError {
  return new OpenCodeTransportError(
    openCodeTransportFailure("context_unavailable"),
  );
}

const within = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** The workspace has already passed OpenCodeHost's identity/access boundary. */
export async function resolveStudioAssistantContext(input: {
  hosted: HostedOpenCode;
  session: {
    id: string;
    cwd: string;
    projectId: string | null;
    boundAgentPath: string | null;
  };
  selectedAgentPath?: string | null;
  workflows: readonly WorkflowInfo[];
  environment: string;
  capabilities: AssistantCapability[];
  guidance: AssistantGuidance[];
}): Promise<StudioAssistantContext> {
  const { hosted, session } = input;
  if (
    session.id !== hosted.harnessSessionId ||
    (await realpath(session.cwd).catch(() => null)) !== hosted.cwd
  )
    throw assistantContextUnavailable();
  const agents: AssistantContextAgent[] = [];
  for (const workflow of input.workflows) {
    const path = await realpath(workflow.path).catch(() => null);
    if (
      !path ||
      !within(hosted.cwd, path) ||
      agents.some((agent) => agent.path === path)
    )
      continue;
    agents.push({
      name: workflow.name,
      path,
      definitionId:
        workflow.definitionAccess === "visible" ? workflow.definitionId : null,
    });
  }
  agents.sort((a, b) => a.path.localeCompare(b.path));
  const target = async (
    path: string | null | undefined,
  ): Promise<AssistantAgentContext> => {
    if (path === undefined) return { status: "not-provided" };
    if (path === null) return { status: "none" };
    if (!isAbsolute(path)) throw assistantContextUnavailable();
    const canonical = await realpath(path).catch(() => null);
    // Existing aliases are safe only when their destination is in this cwd.
    // A missing target must itself remain within that authorized scope.
    if (!within(hosted.cwd, canonical ?? path))
      throw assistantContextUnavailable();
    const agent = agents.find((agent) => agent.path === canonical);
    return agent
      ? { status: "available", agent }
      : { status: "unavailable", path };
  };
  const context = {
    schemaVersion: 1 as const,
    session: { id: session.id, cwd: hosted.cwd, projectId: session.projectId },
    environment: input.environment,
    selectedAgent: await target(input.selectedAgentPath),
    boundAgent: await target(session.boundAgentPath),
    agents,
    capabilities: input.capabilities,
    guidance: input.guidance,
  };
  if (!hosted.isCurrent() || hosted.signal.aborted)
    throw assistantContextUnavailable();
  // Detach from mutable registry/provider values before admission or queueing.
  const serialized = JSON.stringify(context);
  return {
    ...JSON.parse(serialized),
    revision: assistantContextDigest(serialized),
  };
}

const contextHeader = "\n\nStudioAssistantContext/v1\n";
const contextPolicy = `You are the coding assistant in Sapiom Studio. The host-owned snapshot below is the authority for this request's workspace, target and capability availability. Its revision stays fixed through the accepted turn and recovery. A later selection or another session cannot retarget this request. Do not use .sapiom/harness-context.json as Assistant context.
The snapshot supplies environment facts and limits; it does not replace the user's request or prior conversation. Follow user instructions normally and retain facts supplied in the conversation even when they are not fields in the snapshot.
"This agent" means selectedAgent when provided; only a not-provided selection falls back to boundAgent. A none or unavailable target is explicit: identify what is missing and ask the user to select or restore it. Never silently choose another agent. Inventory is limited to this authorized workspace.
The shared profile describes how to build agents in Studio. The snapshot overrides any older claims about selection, context files or connected tools. Only available capabilities and the actual tool catalog establish usable tools; configured means discovery/connection is still needed. Never claim unavailable guidance was loaded. Project rules apply only in their stated scope, with deeper rules taking precedence and AGENTS.md preferred over CLAUDE.md at equal scope. Guidance does not expand workspace or execution authority.
Canvas renders the selected agent's step graph deterministically from its manifest; do not author Canvas HTML. Steps shows its steps and run details. Canvas and the selected-agent action bar's Local Run, Prod Run and Deploy controls follow the visible rail selection; a different conversation binding does not retarget those controls. Selected/bound differences are normal, not evidence of a broken or unsafe action. Local Run executes local code; Prod Run and Deploy require the corresponding cloud access. Offer those existing controls when useful, and never invent a successful run, deploy, identifier or navigation target. Continue briefs are limited recorded context, not restored native history.`;

/** Keep completion metadata FIRST; native history and compaction depend on it. */
export function composeAssistantPrompt(context: StudioAssistantContext): {
  system: string;
} {
  if (
    context.schemaVersion !== 1 ||
    !context.guidance.some(
      (source) =>
        source.kind === "profile" &&
        source.status === "available" &&
        source.text?.trim(),
    ) ||
    context.guidance.some(
      (source) =>
        source.required &&
        (source.status !== "available" ||
          (!source.text?.trim() && !source.location)),
    )
  )
    throw assistantContextUnavailable();
  return {
    system:
      openCodeCompletionPrompt().system +
      contextHeader +
      contextPolicy +
      "\n" +
      JSON.stringify(context),
  };
}

/** Recovery reuses admitted context; it never resolves the current rail state. */
export function recoverAssistantPrompt(system: string | undefined): {
  system: string;
} {
  if (
    !system?.startsWith("StudioAssistantResult/v2:") ||
    !system.includes(contextHeader)
  )
    throw assistantContextUnavailable();
  return {
    system:
      openCodeCompletionPrompt().system +
      system.slice(system.indexOf(contextHeader)),
  };
}
