import { assistantContentHash } from "@sapiom/opencode";
import type {
  HostedOpenCode,
  OpenCodeContextRuntime,
} from "../core/opencode-host.js";
import { FileAssistantSourceStore } from "../core/assistant-source-store.js";
import { assertAssistantRuntimeReady } from "../core/assistant-runtime-readiness.js";
import {
  createAssistantContextDelivery,
  type AssistantContextDelivery,
  type ResolveAssistantCandidate,
} from "../core/studio-assistant-delivery.js";
import {
  assistantContextUnavailable,
  type ResolveAssistantContext,
} from "../core/studio-assistant-context.js";
import { retainAssistantGuidance } from "../core/assistant-sources.js";
import type { AssistantContinuationStore } from "../core/assistant-continuation-store.js";
import { awaitAssistantInspection } from "../core/assistant-lifecycle.js";
import {
  createAssistantContextResolver,
  createAssistantContextCandidateResolver,
  defaultAssistantGuidance,
} from "./studio-assistant.js";

type ContextOptions = Parameters<typeof createAssistantContextResolver>[0];
type CandidateOptions = Parameters<
  typeof createAssistantContextCandidateResolver
>[0];

/** Server-owned, verified activation. No CLI/browser flag or publication is added here. */
export interface ActivatedAssistantContextRuntime extends OpenCodeContextRuntime {
  readonly loadCapabilities?: ContextOptions["loadCapabilities"];
  readonly loadGuidance?: CandidateOptions["loadGuidance"];
}
interface Options {
  activated?: ActivatedAssistantContextRuntime;
  contextOptions: Omit<ContextOptions, "loadGuidance" | "loadCapabilities">;
  assertCurrent: (hosted: HostedOpenCode) => Promise<void>;
  continuations: Pick<AssistantContinuationStore, "readChild">;
}
export interface AssistantContextRuntimeConsumer {
  /** Pass this exact value to the ordinary router; its delivery also owns recovery. */
  context: ResolveAssistantContext | AssistantContextDelivery;
  delivery: AssistantContextDelivery;
  resolveCandidate: ResolveAssistantCandidate;
  assertAvailable(): Promise<void>;
}
const unavailable = (): never => {
  throw assistantContextUnavailable();
};

/** One shared source/delivery owner for Send, recovery, Resume and recorded Continue. */
export function createAssistantContextRuntime(
  options: Options,
): AssistantContextRuntimeConsumer {
  const { activated } = options;
  const assertAvailable = async () => {
    if (
      !activated ||
      typeof activated.start !== "function" ||
      typeof activated.assertAvailable !== "function"
    )
      return unavailable();
    await activated.assertAvailable();
  };
  const acquire = activated
    ? createAssistantContextCandidateResolver({
        ...options.contextOptions,
        loadCapabilities: activated.loadCapabilities,
        loadGuidance: async (context, hosted, signal) => {
          const sources = activated.loadGuidance
            ? await activated.loadGuidance(context, hosted, signal)
            : defaultAssistantGuidance().map((source) =>
                retainAssistantGuidance(source, hosted.contextAuthorityScope),
              );
          signal.throwIfAborted();
          const receipt = await awaitAssistantInspection(
            options.continuations.readChild(hosted.harnessSessionId),
            signal,
          );
          signal.throwIfAborted();
          if (!receipt) return sources;
          const binding = receipt.childBinding;
          if (
            !binding ||
            receipt.childStudioId !== hosted.harnessSessionId ||
            binding.harnessSessionId !== hosted.harnessSessionId ||
            binding.cwd !== hosted.cwd ||
            binding.contextAuthorityScope !== hosted.contextAuthorityScope ||
            assistantContentHash(receipt.brief.text) !== receipt.brief.sha256 ||
            sources.some((source) => source.version.kind === "continuation")
          )
            unavailable();
          // The receipt contributes immutable quoted input, never a parent's accepted ref.
          return [
            ...sources,
            retainAssistantGuidance(
              {
                id: "studio-recorded-continuation",
                kind: "continuation",
                required: true,
                source: `studio:${receipt.sourceBinding.harnessSessionId}/record/${receipt.sourceRecordRevision}`,
                revision: receipt.brief.sha256,
                status: "available",
                text: receipt.brief.text,
              },
              hosted.contextAuthorityScope,
            ),
          ];
        },
      })
    : undefined;
  const resolveCandidate: ResolveAssistantCandidate = async (
    hosted,
    selection,
    signal,
  ) => {
    signal = AbortSignal.any([signal, hosted.signal]);
    signal.throwIfAborted();
    hosted.signal.throwIfAborted();
    await awaitAssistantInspection(assertAvailable(), signal);
    signal.throwIfAborted();
    hosted.signal.throwIfAborted();
    return acquire!(hosted, selection, signal);
  };
  const delivery = createAssistantContextDelivery({
    resolveContext: resolveCandidate,
    storeFor: activated
      ? (hosted) =>
          new FileAssistantSourceStore(
            hosted.stateRoot,
            hosted.contextAuthorityScope,
          )
      : unavailable,
    assertCurrent: options.assertCurrent,
    prepareRuntime: async (_hosted, retained) =>
      assertAssistantRuntimeReady(retained),
  });
  return {
    context: activated
      ? delivery
      : createAssistantContextResolver(options.contextOptions),
    delivery,
    resolveCandidate,
    assertAvailable,
  };
}
