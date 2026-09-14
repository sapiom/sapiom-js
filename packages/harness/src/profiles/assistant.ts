import type { ResolvedEnvironment } from "@sapiom/mcp/auth";
import { isEnvFlagSet } from "../cli/consent.js";
import {
  assistantContextDigest,
  type AssistantGuidance,
} from "../core/studio-assistant-context.js";
import { DEFAULT_SYSTEM_PROMPT, resolveKnownSystemPrompt } from "./default.js";
import { PROJECT_AGENT_PROMPT_APPENDIX } from "./project-agent.js";
import { fetchSystemPromptWithSource } from "./system-prompt-fetch.js";

export async function assistantProfile(
  environment: ResolvedEnvironment,
  loadOverride?: (signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
): Promise<AssistantGuidance> {
  signal?.throwIfAborted();
  const fallback = {
    text: DEFAULT_SYSTEM_PROMPT,
    source: "bundled:studio-profile",
  };
  let loaded: {
    text: string;
    source: string;
    fallback?: AssistantGuidance["fallback"];
  } = fallback;
  if (loadOverride) {
    try {
      loaded = {
        ...fallback,
        fallback: {
          fromSource: "host:studio-profile",
          reason: "Host profile did not supply usable guidance",
        },
      };
      const text = await loadOverride(signal);
      signal?.throwIfAborted();
      if (text.trim()) loaded = { text, source: "host:studio-profile" };
    } catch {
      signal?.throwIfAborted();
      /* The bundled teaching is the required offline fallback. */
    }
  } else if (!isEnvFlagSet(process.env.SAPIOM_HARNESS_PROMPT_FETCH_DISABLED)) {
    loaded = await fetchSystemPromptWithSource(environment, signal);
  }
  signal?.throwIfAborted();
  const text = resolveKnownSystemPrompt(loaded.text);
  return {
    id: "studio-profile",
    kind: "profile",
    required: true,
    status: "available",
    source: text === loaded.text ? loaded.source : "bundled:studio-profile",
    ...(text !== loaded.text
      ? {
          fallback: {
            fromSource: loaded.source,
            reason: "Superseded profile replaced with current bundled guidance",
          },
        }
      : loaded.fallback
        ? { fallback: loaded.fallback }
        : {}),
    revision: assistantContextDigest(text),
    text,
  };
}

/** Common writable project role; tool-specific guidance follows actual wiring. */
export function assistantProjectRole(): AssistantGuidance {
  const text =
    PROJECT_AGENT_PROMPT_APPENDIX.split("\n\n")[0]! +
    "\n</studio-project-agent>";
  return {
    id: "studio-project-role",
    kind: "project",
    required: true,
    status: "available",
    source: "bundled:project-agent-role",
    revision: assistantContextDigest(text),
    text,
  };
}
