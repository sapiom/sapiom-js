import { basename } from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import {
  encodeAssistantContext,
  type AcceptedAssistantContext,
} from "@sapiom/opencode";
import { openCodeTransportFailure } from "../shared/opencode-errors.js";
import type { AssistantRecordBinding } from "../shared/assistant-record.js";
import type { HarnessSession } from "../shared/types.js";
import {
  awaitAssistantInspection,
  type AssistantAttachment,
  type AssistantLifecycleCoordinator,
} from "./assistant-lifecycle.js";
import {
  AssistantContinuationConflictError,
  freezeContinuationCandidate,
  thawContinuationCandidate,
  type AssistantContinuationReceipt,
  type AssistantContinuationStore,
} from "./assistant-continuation-store.js";
import type { AssistantContinuationNative } from "./assistant-continuation-native.js";
import type {
  AssistantAssociation,
  AssistantSessionStore,
} from "./assistant-session-store.js";
import type { AssistantRecordStore } from "./assistant-record-store.js";
import {
  OpenCodeAccessError,
  OpenCodeTransportError,
  type HostedOpenCode,
} from "./opencode-host.js";
import type { SessionManager } from "./session-manager.js";
import type { AssistantContextDelivery } from "./studio-assistant-delivery.js";
import {
  acceptedAssistantRecord,
  type AssistantContextCandidate,
} from "./assistant-sources.js";

export interface AssistantContinueRequest {
  expectedRevision: number;
  expectedRecordRevision: number;
  operationId: string;
}
export interface PreparedAssistantContinuation {
  session: HarnessSession;
  attachment: AssistantAttachment;
  /** Private receipt: the route must explicitly project public provenance. */
  receipt: AssistantContinuationReceipt;
}
interface Options {
  store: AssistantContinuationStore;
  records: Pick<AssistantRecordStore, "read">;
  sessions: Pick<SessionManager, "get" | "allocateDormant">;
  associations: Pick<AssistantSessionStore, "associate">;
  lifecycle: Pick<
    AssistantLifecycleCoordinator,
    | "describe"
    | "snapshot"
    | "subscribe"
    | "prepareContinuation"
    | "inspect"
    | "attach"
    | "use"
  >;
  native: Pick<AssistantContinuationNative, "conversation" | "seed">;
  delivery: AssistantContextDelivery;
  authorize: (id: string) => Promise<AssistantAssociation | null>;
  resolveCandidate: (
    hosted: HostedOpenCode,
    receipt: AssistantContinuationReceipt,
    signal: AbortSignal,
  ) => Promise<AssistantContextCandidate>;
  /** Context runtime activation belongs to the existing delivery/runtime owner. */
  assertAvailable: () => Promise<void>;
  timeoutMs?: number;
}
const reference = ({
  context: _context,
  instructionSet: _set,
  ...ref
}: AcceptedAssistantContext) => ref;
const recordBinding = ({
  harnessSessionId,
  contextAuthorityScope,
  conversationId,
  cwd,
}: AssistantAssociation): AssistantRecordBinding => ({
  harnessSessionId,
  contextAuthorityScope,
  conversationId,
  cwd,
});
const changed = () =>
  new OpenCodeTransportError(openCodeTransportFailure("lifecycle_changed"));
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** One child and one frozen preparation per operation; no ordinary prompt/recovery dispatch. */
export class AssistantContinuation {
  private readonly pending = new Map<
    string,
    { request: string; promise: Promise<PreparedAssistantContinuation> }
  >();
  constructor(private readonly options: Options) {}

  continue(
    id: string,
    request: AssistantContinueRequest,
  ): Promise<PreparedAssistantContinuation> {
    const key = `${id}/${request.operationId}`,
      encoded = JSON.stringify(request);
    const pending = this.pending.get(key);
    if (pending)
      return pending.request === encoded
        ? pending.promise
        : Promise.reject(new AssistantContinuationConflictError());
    const promise = this.run(id, { ...request });
    const entry = { request: encoded, promise };
    this.pending.set(key, entry);
    void promise
      .finally(() => {
        if (this.pending.get(key) === entry) this.pending.delete(key);
      })
      .catch(() => {});
    return promise;
  }

  private async run(
    id: string,
    request: AssistantContinueRequest,
  ): Promise<PreparedAssistantContinuation> {
    const controller = new AbortController(),
      signal = controller.signal;
    const timer = setTimeout(
      () => controller.abort(changed()),
      this.options.timeoutMs ?? 45_000,
    );
    let receipt: AssistantContinuationReceipt | null = null;
    let release: (() => Promise<void>) | undefined;
    const unsubscribe = this.options.lifecycle.subscribe(() => {
      if (receipt?.phase === "prepared") return;
      const state = this.options.lifecycle
        .snapshot()
        .find((row) => row.harnessSessionId === id);
      if (
        state &&
        (state.revision !== request.expectedRevision ||
          state.lifecycle === "ending")
      )
        controller.abort(changed());
    });
    try {
      await awaitAssistantInspection(this.options.assertAvailable(), signal);
      const source = await awaitAssistantInspection(
        this.options.authorize(id),
        signal,
      );
      if (!source || source.harnessSessionId !== id)
        throw new OpenCodeAccessError("Assistant source unavailable");
      const binding = recordBinding(source);
      const sourceSession = this.options.sessions.get(id);
      if (!sourceSession?.agentMapIdentity)
        throw new OpenCodeAccessError("Assistant project unavailable");
      const sourceFacts = {
        cwd: sourceSession.cwd,
        projectId: sourceSession.agentMapIdentity.projectId,
        userId: sourceSession.agentMapIdentity.userId,
      };
      const harness = sourceSession.harness;
      const checkChild = (child: HarnessSession) => {
        if (
          child.harness !== harness ||
          !same(sourceFacts, {
            cwd: child.cwd,
            projectId: child.agentMapIdentity?.projectId,
            userId: child.agentMapIdentity?.userId,
          }) ||
          child.agentMapIdentity?.sessionId !== child.id
        )
          throw new OpenCodeAccessError("Assistant child project changed");
      };
      const check = async () => {
        signal.throwIfAborted();
        if (
          !same(
            source,
            await awaitAssistantInspection(this.options.authorize(id), signal),
          )
        )
          throw new OpenCodeAccessError("Assistant source changed");
        const state = await awaitAssistantInspection(
          this.options.lifecycle.describe(id),
          signal,
        );
        signal.throwIfAborted();
        if (
          receipt?.phase !== "prepared" &&
          (state.revision !== request.expectedRevision ||
            state.lifecycle === "ending")
        )
          throw changed();
        const current = this.options.sessions.get(id);
        if (
          !current ||
          current.harness !== harness ||
          !same(sourceFacts, {
            cwd: current.cwd,
            projectId: current.agentMapIdentity?.projectId,
            userId: current.agentMapIdentity?.userId,
          })
        )
          throw new OpenCodeAccessError("Assistant project changed");
        const child =
          receipt && this.options.sessions.get(receipt.childStudioId);
        if (child) checkChild(child);
      };
      const locking = this.options.store.operationLock(
        binding,
        request.operationId,
      );
      // A timed-out waiter must release a lock it acquires after returning.
      void locking.then(
        (late) => {
          if (signal.aborted && !release) void late().catch(() => {});
        },
        () => {},
      );
      release = await awaitAssistantInspection(locking, signal);
      receipt = await this.options.store.read(binding, request.operationId);
      await check();
      receipt = await this.options.store.reserve(
        binding,
        request.expectedRecordRevision,
        request.expectedRevision,
        request.operationId,
        () => this.options.records.read(binding),
        signal,
      );
      await check();
      // The allocator owns the original project/user/harness digest. Consult it
      // on every retry, including prepared receipts after a same-cwd rebind.
      await this.options.sessions.allocateDormant(id, {
        childSessionId: receipt.childStudioId,
        harness,
        expectedSource: sourceFacts,
      });
      await check();
      if (receipt.phase === "reserved") {
        receipt = await this.options.store.update(
          receipt,
          { phase: "allocated" },
          signal,
        );
      }
      const child = this.options.sessions.get(receipt.childStudioId);
      if (!child)
        throw new OpenCodeAccessError("Prepared Studio child unavailable");
      checkChild(child);
      const childLifecycle = await this.options.lifecycle.describe(child.id);
      if (childLifecycle.lifecycle !== "open") throw changed();
      if (receipt.phase !== "prepared" && childLifecycle.revision !== 0)
        throw changed();
      // A completed receipt is verified through a read-only operation. It must
      // never reacquire mutating preparation while its child is running.
      const prepare =
        receipt.phase === "prepared"
          ? this.options.lifecycle.inspect.bind(this.options.lifecycle)
          : this.options.lifecycle.prepareContinuation.bind(
              this.options.lifecycle,
            );
      const prepared = await prepare(
        child.id,
        childLifecycle.revision,
        async (hosted, preparationSignal) => {
          const operationSignal = AbortSignal.any([
            signal,
            preparationSignal,
            hosted.signal,
          ]);
          const advance = async (
            patch: Parameters<AssistantContinuationStore["update"]>[1],
          ) => {
            await check();
            operationSignal.throwIfAborted();
            receipt = await this.options.store.update(
              receipt!,
              patch,
              operationSignal,
            );
            await check();
            operationSignal.throwIfAborted();
            return receipt;
          };
          if (["allocated", "creating"].includes(receipt!.phase)) {
            const conversationId = await this.options.native.conversation(
              hosted,
              receipt!,
              advance,
              operationSignal,
            );
            await check();
            operationSignal.throwIfAborted();
            const association = await this.options.associations.associate(
              hosted,
              basename(hosted.stateRoot),
              async () => conversationId,
              operationSignal,
            );
            if (!association || association.conversationId !== conversationId)
              throw new AssistantContinuationConflictError();
            await advance({
              phase: "associated",
              childBinding: recordBinding(association),
            });
          }
          const associated = await awaitAssistantInspection(
            this.options.authorize(child.id),
            operationSignal,
          );
          if (
            !associated ||
            !same(recordBinding(associated), receipt!.childBinding) ||
            associated.nativeScope !== basename(hosted.stateRoot) ||
            associated.contextAuthorityScope !== hosted.contextAuthorityScope ||
            associated.cwd !== hosted.cwd
          )
            throw new OpenCodeAccessError("Assistant child binding changed");
          if (receipt!.phase === "associated") {
            const candidate = await awaitAssistantInspection(
              this.options.resolveCandidate(hosted, receipt!, operationSignal),
              operationSignal,
            );
            await advance({
              phase: "accepting",
              frozenCandidate: freezeContinuationCandidate(
                candidate,
                receipt!.childBinding!,
                receipt!.acceptanceId,
              ),
            });
          }
          const candidate = thawContinuationCandidate(
            receipt!.frozenCandidate!,
            receipt!.childBinding!,
            receipt!.acceptanceId,
          );
          let accepted = acceptedAssistantRecord(
            candidate,
            hosted.contextAuthorityScope,
            associated.conversationId,
            receipt!.acceptanceId,
          );
          if (!receipt!.acceptedRef) {
            accepted = await this.options.delivery.acceptFrozen(
              hosted,
              associated.conversationId,
              candidate,
              receipt!.acceptanceId,
              operationSignal,
            );
            await advance({ acceptedRef: reference(accepted) });
          }
          if (
            encodeAssistantContext(reference(accepted)) !==
            encodeAssistantContext(receipt!.acceptedRef)
          )
            throw new AssistantContinuationConflictError();
          // compose reads the exact accepted-source owner; receipt material is never a recovery fallback.
          const { system } = await this.options.delivery.compose(
            hosted,
            associated.conversationId,
            accepted,
            { attemptToken: receipt!.attemptToken },
            operationSignal,
          );
          await check();
          operationSignal.throwIfAborted();
          await this.options.native.seed(
            hosted,
            receipt!,
            system,
            advance,
            operationSignal,
          );
          if (receipt!.phase !== "prepared")
            await advance({ phase: "prepared" });
          await check();
          operationSignal.throwIfAborted();
          return receipt!;
        },
        signal,
      );
      await check();
      const attachment = await this.options.lifecycle.attach(
        child.id,
        childLifecycle.revision,
      );
      await check();
      await this.options.lifecycle.use(child.id, attachment.lease);
      const session = this.options.sessions.get(child.id);
      if (
        !session ||
        attachment.conversationId !== prepared.childBinding?.conversationId
      )
        throw new AssistantContinuationConflictError();
      checkChild(session);
      return { session, attachment, receipt: prepared };
    } finally {
      clearTimeout(timer);
      unsubscribe();
      if (release) await release();
    }
  }
}
