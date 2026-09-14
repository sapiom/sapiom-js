import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  assistantContentHash,
  assistantContextLimits,
  encodeAssistantContext,
  validateAcceptedContextRef,
  type AcceptedContextRef,
  type InstructionSet,
} from "@sapiom/opencode";
import type {
  AssistantRecord,
  AssistantRecordBinding,
} from "../shared/assistant-record.js";
import {
  validateAssistantRecord,
  validateAssistantRecordBinding,
} from "./assistant-record.js";
import { buildAssistantContinuationBrief } from "./assistant-continuation-brief.js";
import {
  acceptedAssistantRecord,
  type AssistantContextCandidate,
} from "./assistant-sources.js";
import {
  assistantDirectory,
  AssistantStorageError,
  readAssistantJson,
  writeAssistantJson,
} from "./assistant-session-files.js";
import { DurableFileLock } from "./durable-file-lock.js";
import {
  estimateBriefTokens,
  RESUME_BRIEF_DEFAULT_MAX_TOKENS,
  RESUME_BRIEF_DEFAULT_MAX_TURNS,
} from "./resume-brief.js";
import type { StudioAssistantContext } from "./studio-assistant-context.js";

export const ASSISTANT_CONTINUATION_MAX_BYTES = 12 * 1024 * 1024;
const count = z.number().int().nonnegative().safe();
const uuid = z.string().uuid();
const binding = z.unknown().transform(validateAssistantRecordBinding);
const phases = [
  "reserved",
  "allocated",
  "creating",
  "associated",
  "accepting",
  "seeding",
  "prepared",
] as const;
const phase = z.enum(phases);
const ref = z.unknown().transform((value): AcceptedContextRef => {
  validateAcceptedContextRef(value);
  return value;
});
const frozenSchema = z
  .object({
    context: z.custom<StudioAssistantContext>(
      (value) => value !== null && typeof value === "object",
    ),
    instructionSet: z.custom<InstructionSet>(
      (value) => value !== null && typeof value === "object",
    ),
    materials: z
      .array(
        z
          .object({
            sourceId: z.string().min(1),
            bytesBase64: z
              .string()
              .max(4 * Math.ceil(assistantContextLimits.bytes / 3)),
          })
          .strict(),
      )
      .max(assistantContextLimits.entries),
  })
  .strict();
/** Pending operation input only. Execution must read accepted content through its source owner. */
export type FrozenContinuationCandidate = Readonly<
  z.infer<typeof frozenSchema>
>;
const receiptSchema = z
  .object({
    version: z.literal(1),
    revision: count.positive(),
    operationId: uuid,
    sourceBinding: binding,
    sourceRecordRevision: count.positive(),
    sourceLifecycleRevision: count,
    childStudioId: uuid,
    brief: z
      .object({
        version: z.literal(1),
        binding,
        recordRevision: count.positive(),
        capturedAt: z.string().datetime(),
        text: z
          .string()
          .min(1)
          .max(RESUME_BRIEF_DEFAULT_MAX_TOKENS * 4),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        estimatedTokens: count.positive().max(RESUME_BRIEF_DEFAULT_MAX_TOKENS),
        retainedTurns: count.positive().max(RESUME_BRIEF_DEFAULT_MAX_TURNS),
        omittedTurns: count,
      })
      .strict(),
    nativeCreationMarker: z.string(),
    seedMessageId: z.string().regex(/^msg_[a-f0-9]{12}[A-Za-z0-9]{14}$/),
    seedPartId: z.string().regex(/^prt_[a-f0-9]{12}[A-Za-z0-9]{14}$/),
    acceptanceId: uuid,
    attemptToken: uuid,
    createdAt: count,
    updatedAt: count,
    phase,
    childBinding: binding.nullable(),
    acceptedRef: ref.nullable(),
    frozenCandidate: frozenSchema.nullable(),
  })
  .strict();
export type AssistantContinuationReceipt = Readonly<
  z.infer<typeof receiptSchema>
>;
const patchSchema = receiptSchema
  .pick({
    phase: true,
    childBinding: true,
    acceptedRef: true,
    frozenCandidate: true,
  })
  .partial()
  .strict();
export type AssistantContinuationPatch = Partial<
  Pick<
    AssistantContinuationReceipt,
    "phase" | "childBinding" | "acceptedRef" | "frozenCandidate"
  >
>;
const linkSchema = z
  .object({
    version: z.literal(1),
    childStudioId: uuid,
    sourceBinding: binding,
    operationId: uuid,
  })
  .strict();
const check: (value: unknown) => asserts value = (value) => {
  if (!value) throw new AssistantStorageError();
};

/** A stale receipt or incompatible retry must be reconciled from durable state. */
export class AssistantContinuationConflictError extends Error {
  readonly code = "CONTINUATION_CHANGED";
  constructor() {
    super(
      "The recorded continuation changed. Read its receipt before retrying.",
    );
  }
}
function snapshot(value: unknown): unknown {
  const text = JSON.stringify(value);
  check(
    typeof text === "string" &&
      Buffer.byteLength(text) <= ASSISTANT_CONTINUATION_MAX_BYTES,
  );
  return JSON.parse(text);
}
function candidateRecord(
  candidate: AssistantContextCandidate,
  child: AssistantRecordBinding,
  acceptanceId: string,
) {
  const accepted = acceptedAssistantRecord(
    candidate,
    child.contextAuthorityScope,
    child.conversationId,
    acceptanceId,
  );
  check(
    accepted.context.session.id === child.harnessSessionId &&
      accepted.context.session.cwd === child.cwd,
  );
  return accepted;
}
/** Persist this detached input before acceptFrozen can commit any accepted manifest. */
export function freezeContinuationCandidate(
  candidate: AssistantContextCandidate,
  child: AssistantRecordBinding,
  acceptanceId: string,
): FrozenContinuationCandidate {
  child = validateAssistantRecordBinding(child);
  const accepted = candidateRecord(candidate, child, acceptanceId);
  const frozen = {
    context: JSON.parse(
      encodeAssistantContext(candidate.context),
    ) as StudioAssistantContext,
    instructionSet: accepted.instructionSet,
    materials: candidate.materials.map(({ sourceId, bytes }) => ({
      sourceId,
      bytesBase64: Buffer.from(bytes).toString("base64"),
    })),
  };
  thawContinuationCandidate(frozen, child, acceptanceId);
  return frozen;
}
/** Decode pending acceptance input; never use it as fallback for missing accepted source material. */
export function thawContinuationCandidate(
  value: FrozenContinuationCandidate,
  child: AssistantRecordBinding,
  acceptanceId: string,
): AssistantContextCandidate {
  const frozen = frozenSchema.parse(snapshot(value));
  let bytes = 0;
  const materials = frozen.materials.map(({ sourceId, bytesBase64 }) => {
    const material = Buffer.from(bytesBase64, "base64");
    bytes += material.length;
    check(
      material.toString("base64") === bytesBase64 &&
        bytes <= assistantContextLimits.bytes,
    );
    return { sourceId, bytes: new Uint8Array(material) };
  });
  encodeAssistantContext(frozen.context);
  const candidate = {
    context: frozen.context,
    instructionSet: frozen.instructionSet,
    materials,
  };
  candidateRecord(
    candidate,
    validateAssistantRecordBinding(child),
    acceptanceId,
  );
  return candidate;
}
function validateReceipt(value: unknown): AssistantContinuationReceipt {
  try {
    const receipt = receiptSchema.parse(snapshot(value));
    const { brief, sourceBinding, childBinding, frozenCandidate, acceptedRef } =
      receipt;
    check(
      isDeepStrictEqual(brief.binding, sourceBinding) &&
        brief.recordRevision === receipt.sourceRecordRevision,
    );
    check(
      brief.sha256 === assistantContentHash(brief.text) &&
        brief.estimatedTokens === estimateBriefTokens(brief.text),
    );
    check(
      receipt.childStudioId !== sourceBinding.harnessSessionId &&
        receipt.updatedAt >= receipt.createdAt,
    );
    check(
      receipt.nativeCreationMarker ===
        `studio-continuation:${receipt.operationId}:${receipt.childStudioId}`,
    );
    check(
      receipt.seedMessageId.slice(4, 16) ===
        seedTimestamp(receipt.createdAt, 1),
    );
    check(
      receipt.seedPartId.slice(4, 16) === seedTimestamp(receipt.createdAt, 2),
    );
    const rank = phases.indexOf(receipt.phase);
    check(rank < 3 || childBinding !== null);
    check(rank < 4 || frozenCandidate !== null);
    check(rank < 5 || acceptedRef !== null);
    if (childBinding)
      check(
        childBinding.harnessSessionId === receipt.childStudioId &&
          childBinding.cwd === sourceBinding.cwd &&
          childBinding.contextAuthorityScope !==
            sourceBinding.contextAuthorityScope &&
          childBinding.conversationId !== sourceBinding.conversationId,
      );
    if (frozenCandidate) {
      check(childBinding !== null);
      const candidate = thawContinuationCandidate(
        frozenCandidate,
        childBinding,
        receipt.acceptanceId,
      );
      const continuation = candidate.instructionSet.sources.filter(
        (source) => source.kind === "continuation",
      );
      check(
        continuation.length === 1 &&
          continuation[0]!.status === "available" &&
          continuation[0]!.contentHash === brief.sha256,
      );
      if (acceptedRef) {
        check(
          acceptedRef.revision ===
            candidateRecord(candidate, childBinding, receipt.acceptanceId)
              .revision,
        );
      }
    }
    if (acceptedRef)
      check(
        childBinding &&
          frozenCandidate &&
          acceptedRef.acceptanceId === receipt.acceptanceId &&
          acceptedRef.authorityScope === childBinding.contextAuthorityScope &&
          acceptedRef.conversationId === childBinding.conversationId,
      );
    return receipt;
  } catch {
    throw new AssistantStorageError();
  }
}
function seedTimestamp(now: number, sequence: number): string {
  const timestamp = BigInt(now) * 4096n + BigInt(sequence);
  const bytes = Buffer.alloc(6);
  for (let index = 0; index < 6; index++)
    bytes[index] = Number((timestamp >> BigInt(40 - 8 * index)) & 255n);
  return bytes.toString("hex");
}
function seedId(prefix: "msg" | "prt", now: number, sequence: number): string {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `${prefix}_${seedTimestamp(now, sequence)}${[...randomBytes(14)].map((byte) => alphabet[byte % 62]).join("")}`;
}

/** Durable Continue intent outside native roots. Creating/seeding never imply safe retry after a crash. */
export class AssistantContinuationStore {
  constructor(private readonly stateRoot: string) {}

  private async location(source: AssistantRecordBinding, operationId: string) {
    const binding = validateAssistantRecordBinding(source);
    uuid.parse(operationId);
    return {
      directory: await assistantDirectory(
        this.stateRoot,
        binding.harnessSessionId,
        binding.contextAuthorityScope,
      ),
      name: `continuation-${operationId}.json`,
      binding,
    };
  }
  /** Hold across external operation steps; receipt CAS uses a separate lock. */
  async operationLock(source: AssistantRecordBinding, operationId: string) {
    const { directory, name } = await this.location(source, operationId);
    return new DurableFileLock(join(directory, `${name}.operation`)).acquire();
  }
  async read(
    source: AssistantRecordBinding,
    operationId: string,
  ): Promise<AssistantContinuationReceipt | null> {
    const { directory, name, binding } = await this.location(
      source,
      operationId,
    );
    const value = await readAssistantJson(
      join(directory, name),
      ASSISTANT_CONTINUATION_MAX_BYTES,
    );
    if (value === null) return null;
    const receipt = validateReceipt(value);
    check(
      isDeepStrictEqual(receipt.sourceBinding, binding) &&
        receipt.operationId === operationId,
    );
    return receipt;
  }
  async reserve(
    source: AssistantRecordBinding,
    expectedRecordRevision: number,
    sourceLifecycleRevision: number,
    operationId: string,
    loadRecord: () => Promise<AssistantRecord | null>,
    signal?: AbortSignal,
  ): Promise<AssistantContinuationReceipt> {
    const { directory, name, binding } = await this.location(
      source,
      operationId,
    );
    count.positive().parse(expectedRecordRevision);
    count.parse(sourceLifecycleRevision);
    const unlock = await new DurableFileLock(join(directory, name)).acquire();
    try {
      signal?.throwIfAborted();
      let receipt = await this.read(binding, operationId);
      if (
        receipt &&
        (receipt.sourceRecordRevision !== expectedRecordRevision ||
          receipt.sourceLifecycleRevision !== sourceLifecycleRevision)
      )
        throw new AssistantContinuationConflictError();
      if (!receipt) {
        const record = validateAssistantRecord(await loadRecord(), binding);
        signal?.throwIfAborted();
        if (record.revision !== expectedRecordRevision)
          throw new AssistantContinuationConflictError();
        const brief = buildAssistantContinuationBrief(record);
        const childStudioId = randomUUID(),
          now = Date.now();
        receipt = validateReceipt({
          version: 1,
          revision: 1,
          operationId,
          sourceBinding: binding,
          sourceRecordRevision: expectedRecordRevision,
          sourceLifecycleRevision,
          childStudioId,
          brief,
          nativeCreationMarker: `studio-continuation:${operationId}:${childStudioId}`,
          seedMessageId: seedId("msg", now, 1),
          seedPartId: seedId("prt", now, 2),
          acceptanceId: randomUUID(),
          attemptToken: randomUUID(),
          createdAt: now,
          updatedAt: now,
          phase: "reserved",
          childBinding: null,
          acceptedRef: null,
          frozenCandidate: null,
        });
        await writeAssistantJson(directory, name, receipt, signal);
      }
      await this.ensureChildLink(receipt, signal);
      signal?.throwIfAborted();
      return receipt;
    } finally {
      await unlock();
    }
  }
  async update(
    current: AssistantContinuationReceipt,
    input: AssistantContinuationPatch,
    signal?: AbortSignal,
  ): Promise<AssistantContinuationReceipt> {
    current = validateReceipt(current);
    const patch = patchSchema.parse(snapshot(input));
    const { directory, name } = await this.location(
      current.sourceBinding,
      current.operationId,
    );
    const unlock = await new DurableFileLock(join(directory, name)).acquire();
    try {
      signal?.throwIfAborted();
      const saved = await this.read(current.sourceBinding, current.operationId);
      if (!saved || !isDeepStrictEqual(saved, current))
        throw new AssistantContinuationConflictError();
      const proposed = { ...saved, ...patch };
      const advance =
        phases.indexOf(proposed.phase) - phases.indexOf(saved.phase);
      if (
        advance < 0 ||
        advance > 1 ||
        ["childBinding", "frozenCandidate", "acceptedRef"].some((key) => {
          const field = key as
            | "childBinding"
            | "frozenCandidate"
            | "acceptedRef";
          return (
            saved[field] !== null &&
            !isDeepStrictEqual(saved[field], proposed[field])
          );
        })
      )
        throw new AssistantContinuationConflictError();
      const next = validateReceipt({
        ...proposed,
        revision: saved.revision + 1,
        updatedAt: Math.max(Date.now(), saved.updatedAt),
      });
      await this.ensureChildLink(saved, signal);
      if (isDeepStrictEqual(proposed, saved)) return saved;
      await writeAssistantJson(directory, name, next, signal);
      signal?.throwIfAborted();
      return next;
    } finally {
      await unlock();
    }
  }
  private async ensureChildLink(
    receipt: AssistantContinuationReceipt,
    signal?: AbortSignal,
  ): Promise<void> {
    const directory = await assistantDirectory(
      this.stateRoot,
      receipt.childStudioId,
    );
    const name = "continuation-preparation.json";
    const unlock = await new DurableFileLock(join(directory, name)).acquire();
    try {
      signal?.throwIfAborted();
      const expected = {
        version: 1 as const,
        childStudioId: receipt.childStudioId,
        sourceBinding: receipt.sourceBinding,
        operationId: receipt.operationId,
      };
      const raw = await readAssistantJson(join(directory, name));
      if (raw !== null)
        check(isDeepStrictEqual(linkSchema.parse(raw), expected));
      else await writeAssistantJson(directory, name, expected, signal);
    } finally {
      await unlock();
    }
  }
  /** Server-only provenance lookup. A linked missing/corrupt receipt is never an ordinary session. */
  async readChild(
    childId: string,
  ): Promise<AssistantContinuationReceipt | null> {
    const directory = await assistantDirectory(this.stateRoot, childId);
    const value = await readAssistantJson(
      join(directory, "continuation-preparation.json"),
    );
    if (value === null) return null;
    const link = linkSchema.parse(value);
    check(link.childStudioId === childId);
    const receipt = await this.read(link.sourceBinding, link.operationId);
    check(receipt !== null && receipt.childStudioId === childId);
    return receipt;
  }
  /** Lookup index only: an absent marker permits ordinary sessions; every linked child waits for prepared. */
  async canAttach(childId: string): Promise<boolean> {
    try {
      const receipt = await this.readChild(childId);
      return receipt === null || receipt.phase === "prepared";
    } catch {
      return false;
    }
  }
}
