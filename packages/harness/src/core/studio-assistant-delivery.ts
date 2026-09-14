import { randomUUID } from "node:crypto";
import {
  encodeAssistantContext,
  parseStudioAssistantSystem,
  serializeAcceptedAssistantSystem,
  studioAssistantCompletionSystem,
  validateAcceptedAssistantContext,
  type AcceptedAssistantContext,
  type AcceptedContextRef,
  type AcceptedAssistantWireV2,
} from "@sapiom/opencode";
import {
  OpenCodeTransportError,
  type HostedOpenCode,
} from "./opencode-host.js";
import { assistantContextUnavailable } from "./studio-assistant-context.js";
import {
  acceptedAssistantRecord,
  validateAssistantMaterials,
  type AssistantContextCandidate,
} from "./assistant-sources.js";
import type {
  AssistantSourceStore,
  RetainedAssistantContext,
} from "./assistant-source-store.js";

export type ResolveAssistantCandidate = (
  hosted: HostedOpenCode,
  selection: string | null | undefined,
  signal: AbortSignal,
) => Promise<AssistantContextCandidate>;
interface Options {
  resolveContext: ResolveAssistantCandidate;
  storeFor: (hosted: HostedOpenCode) => AssistantSourceStore;
  assertCurrent: (hosted: HostedOpenCode) => Promise<void>;
  /** Verify that this native runtime can execute the accepted material generation. */
  prepareRuntime: (
    hosted: HostedOpenCode,
    retained: RetainedAssistantContext,
    signal: AbortSignal,
  ) => Promise<void>;
}
export interface AssistantContextDelivery {
  accept(
    hosted: HostedOpenCode,
    conversationId: string,
    selection: string | null | undefined,
    signal: AbortSignal,
  ): Promise<AcceptedAssistantContext>;
  /**
   * Accept a durably frozen candidate for the new child's own Studio ID/scope.
   * The receipt owner freezes exact inputs and acceptanceId before this call,
   * proves conversationId is the child's native association, and reuses both on
   * retry. This never resolves live guidance or adopts a parent's accepted ref;
   * the source store remains the sole authority for committed accepted content.
   */
  acceptFrozen(
    hosted: HostedOpenCode,
    conversationId: string,
    candidate: AssistantContextCandidate,
    acceptanceId: string,
    signal: AbortSignal,
  ): Promise<AcceptedAssistantContext>;
  compose(
    hosted: HostedOpenCode,
    conversationId: string,
    accepted: AcceptedAssistantContext,
    attempt: { readonly attemptToken: string },
    signal: AbortSignal,
  ): Promise<{ system: string }>;
  recover(
    hosted: HostedOpenCode,
    conversationId: string,
    savedSystem: string | undefined,
    signal: AbortSignal,
  ): Promise<{ system: string }>;
}
const referenceOf = ({
  context: _context,
  instructionSet: _instructions,
  ...ref
}: AcceptedAssistantContext): AcceptedContextRef => ref;

/** One acceptance/composition service; native association, admission and dispatch stay with their owners. */
export function createAssistantContextDelivery(
  options: Options,
): AssistantContextDelivery {
  const authority = (hosted: HostedOpenCode, conversationId: string) => ({
    authorityScope: hosted.contextAuthorityScope,
    conversationId,
  });
  async function current(hosted: HostedOpenCode, signal: AbortSignal) {
    signal.throwIfAborted();
    hosted.signal.throwIfAborted();
    await options.assertCurrent(hosted);
    signal.throwIfAborted();
    hosted.signal.throwIfAborted();
  }
  async function safe<T>(
    hosted: HostedOpenCode,
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      await current(hosted, signal);
      const result = await run();
      await current(hosted, signal);
      return result;
    } catch (error) {
      return fail(hosted, signal, error);
    }
  }
  function fail(
    hosted: HostedOpenCode,
    signal: AbortSignal,
    error: unknown,
  ): never {
    signal.throwIfAborted();
    hosted.signal.throwIfAborted();
    if (error instanceof OpenCodeTransportError) throw error;
    throw assistantContextUnavailable();
  }
  function checkFacts(
    hosted: HostedOpenCode,
    accepted: AcceptedAssistantContext,
  ) {
    if (
      accepted.authorityScope !== hosted.contextAuthorityScope ||
      accepted.context.session.id !== hosted.harnessSessionId ||
      accepted.context.session.cwd !== hosted.cwd
    )
      throw assistantContextUnavailable();
  }
  async function compose(
    hosted: HostedOpenCode,
    conversationId: string,
    ref: AcceptedContextRef,
    token: string,
    signal: AbortSignal,
  ) {
    if (ref.conversationId !== conversationId)
      throw assistantContextUnavailable();
    const completionSystem = studioAssistantCompletionSystem(token);
    const retained = await options
      .storeFor(hosted)
      .readAccepted(ref, authority(hosted, conversationId), signal);
    await current(hosted, signal);
    const { accepted } = retained;
    validateAcceptedAssistantContext(accepted);
    checkFacts(hosted, accepted);
    if (
      encodeAssistantContext(referenceOf(accepted)) !==
      encodeAssistantContext(ref)
    )
      throw assistantContextUnavailable();
    await options.prepareRuntime(hosted, retained, signal);
    await current(hosted, signal);
    return materializedSystem(hosted, retained, ref, token, completionSystem);
  }
  function materializedSystem(
    hosted: HostedOpenCode,
    { accepted, sources }: RetainedAssistantContext,
    ref: AcceptedContextRef,
    token: string,
    completionSystem = studioAssistantCompletionSystem(token),
  ) {
    const inline = accepted.instructionSet.sources.flatMap((source) => {
      if (source.status !== "available" || source.format === "skill-package")
        return [];
      const body = sources.get(source.id);
      if (!body || body.format !== source.format)
        throw assistantContextUnavailable();
      return [
        {
          sourceId: source.id,
          text: body.text,
          kind: source.kind,
          format: body.format,
        },
      ];
    });
    const policy = inline.find((source) => source.kind === "policy");
    if (!policy) throw assistantContextUnavailable();
    const text = ({ sourceId, text }: { sourceId: string; text: string }) => ({
      sourceId,
      text,
    });
    const wire: AcceptedAssistantWireV2 = {
      schemaVersion: 2,
      accepted: ref,
      attemptToken: token,
      context: accepted.context,
      stable: {
        policy: text(policy),
        guidance: inline
          .filter(
            (source) =>
              source.format === "utf8" && source.sourceId !== policy.sourceId,
          )
          .map(text),
        manifests: inline
          .filter((source) => source.format === "json")
          .map(text),
        sourceManifest: accepted.instructionSet,
      },
    };
    const system = serializeAcceptedAssistantSystem(completionSystem, wire);
    parseStudioAssistantSystem(system, {
      ...authority(hosted, ref.conversationId),
      attemptToken: token,
    });
    return { system };
  }
  function prepareAcceptance(
    hosted: HostedOpenCode,
    conversationId: string,
    candidate: AssistantContextCandidate,
    acceptanceId: string,
  ) {
    const accepted = acceptedAssistantRecord(
      candidate,
      hosted.contextAuthorityScope,
      conversationId,
      acceptanceId,
    );
    checkFacts(hosted, accepted);
    // acceptedAssistantRecord bounds and detaches facts/manifest. Copy the
    // validated materials too, before authority IO can yield to caller mutation.
    const materials = candidate.materials.map(({ sourceId, bytes }) => ({
      sourceId,
      bytes: new Uint8Array(bytes),
    }));
    // UUID attempts have fixed width; budget the complete envelope before commit.
    materializedSystem(
      hosted,
      {
        accepted,
        sources: validateAssistantMaterials(
          accepted.instructionSet,
          materials,
          hosted.contextAuthorityScope,
        ),
      },
      referenceOf(accepted),
      accepted.acceptanceId,
    );
    return { accepted, materials };
  }
  async function retainAcceptance(
    hosted: HostedOpenCode,
    conversationId: string,
    prepared: ReturnType<typeof prepareAcceptance>,
    signal: AbortSignal,
  ) {
    checkFacts(hosted, prepared.accepted);
    await options
      .storeFor(hosted)
      .retainAccepted(
        prepared.accepted,
        prepared.materials,
        authority(hosted, conversationId),
        signal,
      );
    return prepared.accepted;
  }
  return {
    accept(hosted, conversationId, selection, signal) {
      return safe(hosted, signal, async () => {
        const candidate = await options.resolveContext(
          hosted,
          selection,
          signal,
        );
        await current(hosted, signal);
        return retainAcceptance(
          hosted,
          conversationId,
          prepareAcceptance(hosted, conversationId, candidate, randomUUID()),
          signal,
        );
      });
    },
    async acceptFrozen(
      hosted,
      conversationId,
      candidate,
      acceptanceId,
      signal,
    ) {
      try {
        signal.throwIfAborted();
        hosted.signal.throwIfAborted();
        const prepared = prepareAcceptance(
          hosted,
          conversationId,
          candidate,
          acceptanceId,
        );
        return await safe(hosted, signal, () =>
          retainAcceptance(hosted, conversationId, prepared, signal),
        );
      } catch (error) {
        return fail(hosted, signal, error);
      }
    },
    compose(hosted, conversationId, accepted, attempt, signal) {
      return safe(hosted, signal, async () => {
        validateAcceptedAssistantContext(accepted);
        return compose(
          hosted,
          conversationId,
          referenceOf(accepted),
          attempt.attemptToken,
          signal,
        );
      });
    },
    recover(hosted, conversationId, savedSystem, signal) {
      return safe(hosted, signal, async () => {
        const parsed = parseStudioAssistantSystem(
          savedSystem,
          authority(hosted, conversationId),
        );
        if (parsed.kind === "accepted-v2")
          return compose(
            hosted,
            conversationId,
            parsed.wire.accepted,
            randomUUID(),
            signal,
          );
        if (
          parsed.kind !== "legacy-inline-v1" ||
          parsed.context.session.id !== hosted.harnessSessionId ||
          parsed.context.session.cwd !== hosted.cwd ||
          parsed.context.guidance.some(
            (source) =>
              source.status === "available" &&
              (source.location || !source.text?.trim()),
          )
        )
          throw assistantContextUnavailable();
        // Explicit legacy compatibility: preserve exact inline facts and text, with no new acceptance or live fetch.
        const system =
          studioAssistantCompletionSystem(randomUUID()) + parsed.suffix;
        parseStudioAssistantSystem(system, authority(hosted, conversationId));
        return { system };
      });
    },
  };
}
