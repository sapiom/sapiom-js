import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { isConversationId } from "../shared/assistant-state.js";
import type { AssistantLifecycle } from "../shared/assistant-session.js";
import { DurableFileLock } from "./durable-file-lock.js";
import {
  assistantDirectory,
  AssistantStorageError,
  authorityScopePattern,
  readAssistantJson,
  studioIdPattern,
  writeAssistantJson,
} from "./assistant-session-files.js";

export interface AssistantBindingKey {
  harnessSessionId: string;
  contextAuthorityScope: string;
  cwd: string;
}
export interface AssistantAssociation extends AssistantBindingKey {
  version: 1;
  conversationId: string;
  nativeScope: string;
  createdAt: number;
}
const lifecycleSchema = z
  .object({
    version: z.literal(1),
    harnessSessionId: z.string().regex(studioIdPattern),
    revision: z.number().int().nonnegative().safe(),
    lifecycle: z.enum(["open", "ending", "ended"]),
    execution: z.enum(["enabled", "paused"]),
    updatedAt: z.number().int().nonnegative().safe(),
  })
  .strict();
const associationSchema = z
  .object({
    version: z.literal(1),
    harnessSessionId: z.string().regex(studioIdPattern),
    contextAuthorityScope: z.string().regex(authorityScopePattern),
    cwd: z.string().refine(isAbsolute),
    conversationId: z.string().refine(isConversationId),
    nativeScope: z.string().regex(authorityScopePattern),
    createdAt: z.number().int().nonnegative().safe(),
  })
  .strict();

const resumeRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative().safe(),
    bindingDigest: z.string().regex(authorityScopePattern),
  })
  .strict();
const resumeOperationSchema = resumeRequestSchema.extend({
  version: z.literal(1),
  committedRevision: z.number().int().positive().safe(),
});
export type AssistantResumeRequest = z.infer<typeof resumeRequestSchema>;
export type AssistantResumeOperation = z.infer<typeof resumeOperationSchema>;
const controlSchema = lifecycleSchema
  .extend({ resumeOperation: resumeOperationSchema.optional() })
  .refine(
    (row) =>
      !row.resumeOperation ||
      (row.resumeOperation.expectedRevision <
        row.resumeOperation.committedRevision &&
        row.resumeOperation.committedRevision <= row.revision),
  );
type AssistantControl = z.infer<typeof controlSchema>;
const publicLifecycle = ({
  resumeOperation: _private,
  ...lifecycle
}: AssistantControl): AssistantLifecycle => lifecycle;

/** Digest every validated saved-association field, never a client-selected path. */
export function assistantResumeBindingDigest(
  binding: AssistantAssociation,
): string {
  return createHash("sha256")
    .update(JSON.stringify(associationSchema.parse(binding)))
    .digest("hex");
}

export class AssistantSessionRevisionError extends Error {
  constructor() {
    super("Assistant session changed. Please retry.");
  }
}

/** Lifecycle ownership is independent of eligibility; content always requires its exact binding. */
export class AssistantSessionStore {
  constructor(readonly stateRoot: string) {}

  async lifecycle(id: string): Promise<AssistantLifecycle | null> {
    const control = await this.control(id);
    return control ? publicLifecycle(control) : null;
  }

  private async control(id: string): Promise<AssistantControl | null> {
    const directory = await assistantDirectory(this.stateRoot, id);
    const raw = await readAssistantJson(join(directory, "lifecycle.json"));
    if (raw === null) return null;
    const parsed = controlSchema.safeParse(raw);
    if (!parsed.success || parsed.data.harnessSessionId !== id)
      throw new AssistantStorageError();
    return parsed.data;
  }

  /** Read the public header and private operation proof from one atomic generation. */
  async resumeState(
    id: string,
  ): Promise<{
    lifecycle: AssistantLifecycle | null;
    resumeOperation: AssistantResumeOperation | null;
  }> {
    const control = await this.control(id);
    return {
      lifecycle: control ? publicLifecycle(control) : null,
      resumeOperation: control?.resumeOperation ?? null,
    };
  }

  async transition(
    id: string,
    expected: number,
    next: Pick<AssistantLifecycle, "lifecycle" | "execution">,
    signal?: AbortSignal,
  ): Promise<AssistantLifecycle> {
    const directory = await assistantDirectory(this.stateRoot, id);
    const unlock = await new DurableFileLock(
      join(directory, "lifecycle.json"),
    ).acquire();
    try {
      signal?.throwIfAborted();
      const current = await this.control(id);
      if ((current?.revision ?? 0) !== expected)
        throw new AssistantSessionRevisionError();
      const updated = lifecycleSchema.parse({
        version: 1,
        harnessSessionId: id,
        revision: expected + 1,
        ...next,
        updatedAt: Date.now(),
      });
      await writeAssistantJson(
        directory,
        "lifecycle.json",
        {
          ...updated,
          ...(current?.resumeOperation
            ? { resumeOperation: current.resumeOperation }
            : {}),
        },
        signal,
      );
      return updated;
    } finally {
      await unlock();
    }
  }

  /** Commit Resume and its idempotence proof together. A replay of this exact
   * write returns its existing result; a restarted runtime uses the recovered
   * committed revision as a new CAS base and must again begin paused. */
  async commitResume(
    id: string,
    expected: number,
    input: AssistantResumeRequest,
    execution: AssistantLifecycle["execution"],
    signal?: AbortSignal,
  ): Promise<AssistantLifecycle> {
    const request = resumeRequestSchema.parse(input);
    const directory = await assistantDirectory(this.stateRoot, id);
    const unlock = await new DurableFileLock(
      join(directory, "lifecycle.json"),
    ).acquire();
    try {
      signal?.throwIfAborted();
      const current = await this.control(id);
      const revision = current?.revision ?? 0;
      const proof = current?.resumeOperation;
      const retry = proof?.operationId === request.operationId;
      if (
        retry &&
        (proof.expectedRevision !== request.expectedRevision ||
          proof.bindingDigest !== request.bindingDigest ||
          proof.committedRevision !== revision ||
          current?.lifecycle !== "open")
      )
        throw new AssistantSessionRevisionError();
      if (retry && expected === request.expectedRevision)
        return publicLifecycle(current!);
      if (
        revision !== expected ||
        (!retry && revision !== request.expectedRevision) ||
        current?.lifecycle === "ending" ||
        (execution === "enabled" &&
          (current?.lifecycle !== "open" || current.execution !== "enabled"))
      )
        throw new AssistantSessionRevisionError();
      const updated = lifecycleSchema.parse({
        version: 1,
        harnessSessionId: id,
        revision: revision + 1,
        lifecycle: "open",
        execution,
        updatedAt: Date.now(),
      });
      await writeAssistantJson(
        directory,
        "lifecycle.json",
        {
          ...updated,
          resumeOperation: {
            ...request,
            version: 1,
            committedRevision: updated.revision,
          },
        },
        signal,
      );
      return updated;
    } finally {
      await unlock();
    }
  }

  async association(
    key: AssistantBindingKey,
  ): Promise<AssistantAssociation | null> {
    const directory = await assistantDirectory(
      this.stateRoot,
      key.harnessSessionId,
      key.contextAuthorityScope,
    );
    const raw = await readAssistantJson(join(directory, "association.json"));
    if (raw === null) return null;
    const parsed = associationSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.harnessSessionId !== key.harnessSessionId ||
      parsed.data.contextAuthorityScope !== key.contextAuthorityScope ||
      parsed.data.cwd !== key.cwd ||
      parsed.data.conversationId === key.harnessSessionId
    )
      throw new AssistantStorageError();
    return parsed.data;
  }

  /** Import legacy identity without native IO. Never reuse its sidecar for a second authority. */
  async associate(
    key: AssistantBindingKey,
    nativeScope: string,
    create: (() => Promise<string>) | undefined,
    signal?: AbortSignal,
  ): Promise<AssistantAssociation | null> {
    key = {
      harnessSessionId: key.harnessSessionId,
      contextAuthorityScope: key.contextAuthorityScope,
      cwd: key.cwd,
    };
    if (!authorityScopePattern.test(nativeScope) || !isAbsolute(key.cwd))
      throw new AssistantStorageError();
    const directory = await assistantDirectory(
      this.stateRoot,
      key.harnessSessionId,
    );
    const unlock = await new DurableFileLock(
      join(directory, "association"),
    ).acquire();
    try {
      signal?.throwIfAborted();
      const current = await this.association(key);
      if (current) {
        if (current.nativeScope !== nativeScope)
          throw new AssistantStorageError();
        return current;
      }
      const bindings = await readdir(join(directory, "bindings"));
      let alreadyImported = false;
      for (const scope of bindings) {
        if (!authorityScopePattern.test(scope))
          throw new AssistantStorageError();
        const otherDirectory = await assistantDirectory(
          this.stateRoot,
          key.harnessSessionId,
          scope,
        );
        const other = await readAssistantJson(
          join(otherDirectory, "association.json"),
        );
        if (other !== null) {
          const parsed = associationSchema.safeParse(other);
          if (
            !parsed.success ||
            parsed.data.harnessSessionId !== key.harnessSessionId ||
            parsed.data.contextAuthorityScope !== scope ||
            parsed.data.conversationId === key.harnessSessionId
          )
            throw new AssistantStorageError();
          if (parsed.data.nativeScope === nativeScope) alreadyImported = true;
        }
      }
      let conversationId: string | undefined;
      if (!alreadyImported) {
        const legacy = join(
          this.stateRoot,
          "opencode",
          nativeScope,
          "association.json",
        );
        const releaseLegacy = await new DurableFileLock(legacy).acquire();
        try {
          const saved = await readAssistantJson(legacy);
          if (saved !== null) {
            const parsed = z
              .object({
                version: z.literal(1),
                conversationId: z.string().refine(isConversationId),
              })
              .strict()
              .safeParse(saved);
            if (
              !parsed.success ||
              parsed.data.conversationId === key.harnessSessionId
            )
              throw new AssistantStorageError();
            conversationId = parsed.data.conversationId;
          }
        } finally {
          await releaseLegacy();
        }
      }
      conversationId ??= await create?.();
      if (conversationId === undefined) return null;
      const record = associationSchema.parse({
        version: 1,
        ...key,
        nativeScope,
        conversationId,
        createdAt: Date.now(),
      });
      if (record.conversationId === key.harnessSessionId)
        throw new AssistantStorageError();
      const bindingDirectory = await assistantDirectory(
        this.stateRoot,
        key.harnessSessionId,
        key.contextAuthorityScope,
      );
      await writeAssistantJson(
        bindingDirectory,
        "association.json",
        record,
        signal,
      );
      return record;
    } finally {
      await unlock();
    }
  }
}
