import { createHash, randomUUID } from "node:crypto";
import type { CdpConnection } from "./cdp.js";
import type { Frame } from "./merchant-frame.js";
import {
  NativeCardinalDelivery,
  type NativeCardinalTarget,
} from "./native-cardinal-delivery.js";
export type { NativeCardinalTarget } from "./native-cardinal-delivery.js";
import type { NativeReturn, VerificationRequest } from "./verification.js";

// Qualified Braintree 3.139.0 / Cardinal 2.1.0 callbacks. Unknown native code stays native before capture.
const VALIDATE = new Set([
  // Published minified and unminified three-d-secure.js, respectively.
  "dd0600cfe743a39e039245102de4efc2b48364b921cb5ba0107bd03f37746eae",
  "65ca677c9f6dfeeee42109e4e39783f2586493549b40e63f6628cb004e463e8b",
]);
const CLEANUP =
  "0ac485bd823b7139ca7851614bbe01e7d9635b191a19ff54db2946cefb63e576";
type Remote = {
  objectId?: string;
  type?: string;
  subtype?: string;
  className?: string;
  description?: string;
  value?: unknown;
};
type Property = { name: string; value?: Remote };
type Properties = { result: Property[]; internalProperties?: Property[] };
type Evaluation = { result?: Remote; exceptionDetails?: unknown };
type Context = { id: number; epoch: number };
/** Bounded inspection of an already-running native verifier; it owns no browser or payment request. */
export class NativeCardinal {
  private readonly contexts = new Map<string, Context>();
  private readonly enabled = new Map<string, Promise<unknown>>();
  private readonly sessions = new Set<string>();
  private readonly group = `sapiom-native-return-${randomUUID()}`;
  private epoch = 0;
  private readonly delivery: NativeCardinalDelivery;
  private readonly unsubscribe: () => void;
  private readonly network = new Map<string, Promise<unknown>>();
  private lookup?: {
    sessionId: string;
    requestId: string;
    url: string;
    received: boolean;
    result: Promise<string | undefined>;
    resolve: (nonce?: string) => void;
  };

  constructor(private readonly cdp: Pick<CdpConnection, "send" | "onEvent">) {
    this.delivery = new NativeCardinalDelivery(cdp);
    this.unsubscribe = cdp.onEvent((event) => {
      const lookup = this.lookup;
      if (
        lookup &&
        event.sessionId === lookup.sessionId &&
        event.params.requestId === lookup.requestId
      ) {
        if (event.method === "Network.responseReceived") {
          const response = event.params.response as
            | { url?: string; status?: number }
            | undefined;
          lookup.received =
            response?.url === lookup.url &&
            typeof response.status === "number" &&
            response.status >= 200 &&
            response.status < 300;
          if (!lookup.received) lookup.resolve();
        } else if (event.method === "Network.loadingFailed") lookup.resolve();
        else if (event.method === "Network.loadingFinished") {
          if (
            !lookup.received ||
            Number(event.params.encodedDataLength) > 65536
          )
            lookup.resolve();
          else void this.readLookup(lookup);
        }
      }
      const params = event.params as {
        context?: {
          id: number;
          auxData?: { isDefault?: boolean; frameId?: string };
        };
        executionContextId?: number;
      };
      if (
        event.method === "Runtime.executionContextCreated" &&
        event.sessionId &&
        params.context?.auxData?.isDefault &&
        typeof params.context.auxData.frameId === "string"
      ) {
        this.contexts.set(
          `${event.sessionId}:${params.context.auxData.frameId}`,
          { id: params.context.id, epoch: ++this.epoch },
        );
      } else if (
        event.method === "Runtime.executionContextDestroyed" ||
        event.method === "Runtime.executionContextsCleared"
      ) {
        for (const [key, context] of this.contexts) {
          if (
            key.startsWith(`${event.sessionId}:`) &&
            (event.method.endsWith("Cleared") ||
              context.id === params.executionContextId)
          )
            this.contexts.delete(key);
        }
      }
    });
  }

  /** Observe only the original lookup response: Braintree upgrades the tokenization nonce here. */
  enableLookup(sessionId: string) {
    if (!this.network.has(sessionId))
      this.network.set(
        sessionId,
        this.cdp.send(
          "Network.enable",
          { maxTotalBufferSize: 65536, maxResourceBufferSize: 32768 },
          sessionId,
          5000,
        ),
      );
    return this.network.get(sessionId)!;
  }

  async watchLookup(request: VerificationRequest) {
    if (this.lookup || !request.networkId)
      throw new Error("Native lookup unavailable");
    let resolve!: (nonce?: string) => void;
    const result = new Promise<string | undefined>((done) => {
      resolve = done;
    });
    this.lookup = {
      sessionId: request.sessionId,
      requestId: request.networkId,
      url: request.url,
      received: false,
      result,
      resolve,
    };
    try {
      await this.enableLookup(request.sessionId);
    } catch (error) {
      resolve();
      throw error;
    }
  }

  private async readLookup(lookup: NonNullable<NativeCardinal["lookup"]>) {
    try {
      const response = (await this.cdp.send(
        "Network.getResponseBody",
        { requestId: lookup.requestId },
        lookup.sessionId,
        5000,
      )) as { body: string; base64Encoded?: boolean };
      if (typeof response.body !== "string" || response.body.length > 65536)
        return;
      const text = response.base64Encoded
        ? Buffer.from(response.body, "base64").toString("utf8")
        : response.body;
      if (Buffer.byteLength(text) > 32768) return;
      const body = JSON.parse(text);
      const nonce = body.paymentMethod?.nonce;
      if (
        !body.errors?.length &&
        typeof nonce === "string" &&
        nonce.length > 0 &&
        nonce.length <= 255
      )
        lookup.resolve(nonce);
    } catch {
      /* An unavailable lookup leaves the existing challenge native. */
    } finally {
      lookup.resolve();
    }
  }

  async lookupNonce() {
    if (!this.lookup) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.lookup.result,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async context(frame: Frame) {
    if (!this.enabled.has(frame.sessionId)) {
      this.enabled.set(
        frame.sessionId,
        this.cdp.send("Runtime.enable", {}, frame.sessionId, 5000),
      );
      this.sessions.add(frame.sessionId);
    }
    await this.enabled.get(frame.sessionId);
    return this.contexts.get(`${frame.sessionId}:${frame.frameId}`);
  }

  async bind(frame: Frame, nonce: string): Promise<NativeCardinalTarget> {
    const deadline = Date.now() + 5000;
    const context = await this.context(frame);
    if (!context) throw new Error("Native checkout context unavailable");
    const send = (method: string, params: Record<string, unknown>) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("Native checkout inspection timed out");
      return this.cdp.send(method, params, frame.sessionId, remaining);
    };
    const properties = async (objectId: string) =>
      (await send("Runtime.getProperties", {
        objectId,
        ownProperties: true,
      })) as Properties;
    const scopes = async (objectId: string) => {
      const ref = (await properties(objectId)).internalProperties?.find(
        (entry) => entry.name === "[[Scopes]]",
      )?.value?.objectId;
      if (!ref) return [];
      return (await properties(ref)).result
        .filter(
          (entry) =>
            /^\d+$/.test(entry.name) &&
            entry.value?.objectId &&
            !/Global/.test(entry.value.description ?? ""),
        )
        .slice(0, 6)
        .map((entry) => entry.value!.objectId!);
    };
    const evaluated = (await send("Runtime.evaluate", {
      expression: "globalThis.Cardinal && globalThis.Cardinal.on",
      contextId: context.id,
      objectGroup: this.group,
      returnByValue: false,
    })) as Evaluation;
    if (evaluated.result?.type !== "function" || !evaluated.result.objectId)
      throw new Error("Native verifier unavailable");
    const queue = (await scopes(evaluated.result.objectId)).map((id) => ({
      id,
      depth: 0,
    }));
    const seen = new Set<string>();
    while (queue.length && seen.size < 80) {
      const current = queue.shift()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      const props = await properties(current.id);
      const bucket = props.result.find(
        (entry) => entry.name === "payments.validated",
      )?.value?.objectId;
      if (bucket) {
        const subscribers = (await properties(bucket)).result.find(
          (entry) => entry.name === "subscribers",
        )?.value?.objectId;
        if (!subscribers) continue;
        const entries = (await properties(subscribers)).result.filter((entry) =>
          /^\d+$/.test(entry.name),
        );
        if (entries.length !== 2)
          throw new Error("Unsupported native verifier subscribers");
        const callbacks = new Map<string, string>();
        for (const entry of entries) {
          if (!entry.value?.objectId)
            throw new Error("Unsupported native verifier subscriber");
          const fn = (await properties(entry.value.objectId)).result.find(
            (property) => property.name === "callback",
          )?.value;
          if (fn?.type !== "function" || !fn.objectId)
            throw new Error("Unsupported native verifier callback");
          const source = (await send("Runtime.callFunctionOn", {
            objectId: fn.objectId,
            functionDeclaration:
              "function() { return Function.prototype.toString.call(this); }",
            returnByValue: true,
          })) as Evaluation;
          if (typeof source.result?.value !== "string")
            throw new Error("Native verifier unavailable");
          callbacks.set(
            createHash("sha256").update(source.result.value).digest("hex"),
            fn.objectId,
          );
        }
        const handler = [...callbacks].find(([hash]) =>
            VALIDATE.has(hash),
          )?.[1],
          cleanup = callbacks.get(CLEANUP);
        if (!handler || !cleanup)
          throw new Error("Unsupported native verifier implementation");
        for (const scope of await scopes(handler)) {
          for (const variable of (await properties(scope)).result) {
            if (
              !variable.value?.objectId ||
              variable.value.type !== "object" ||
              variable.value.className === "Window"
            )
              continue;
            const candidate = variable.value.objectId;
            const bound = (await send("Runtime.callFunctionOn", {
              objectId: candidate,
              functionDeclaration:
                "function(nonce) { return typeof this._performJWTValidation === 'function' && typeof this._client?.request === 'function' && this._lookupPaymentMethod?.nonce === nonce && typeof this._verifyCardPromisePlus?.then === 'function'; }",
              arguments: [{ value: nonce }],
              returnByValue: true,
            })) as Evaluation;
            if (bound.result?.value !== true) continue;
            const members = (await properties(candidate)).result;
            const pending = members.find(
              (member) => member.name === "_verifyCardPromisePlus",
            )?.value?.objectId;
            const method = members.find(
              (member) => member.name === "_lookupPaymentMethod",
            )?.value?.objectId;
            if (pending && method)
              return {
                frame,
                context,
                framework: candidate,
                handler,
                cleanup,
                pending,
                method,
              };
          }
        }
        throw new Error("Native verifier attempt mismatch");
      }
      if (current.depth >= 3 || props.result.length > 80) continue;
      for (const entry of props.result) {
        const value = entry.value;
        if (
          !value?.objectId ||
          value.type !== "object" ||
          value.subtype === "null" ||
          !["Array", "Object", undefined].includes(value.className) ||
          [
            "globalThis",
            "window",
            "self",
            "document",
            "exports",
            "module",
            "prototype",
          ].includes(entry.name)
        )
          continue;
        queue.push({ id: value.objectId, depth: current.depth + 1 });
      }
    }
    throw new Error("Native verifier unavailable");
  }

  async deliver(
    target: NativeCardinalTarget,
    result: NativeReturn,
    expiresAt: string,
  ) {
    if ((await this.context(target.frame)) !== target.context)
      throw new Error("Native return context changed");
    await this.delivery.deliver(target, result, expiresAt);
  }

  async dispose() {
    this.unsubscribe();
    await Promise.allSettled(
      [...this.sessions].map((session) =>
        this.cdp.send(
          "Runtime.releaseObjectGroup",
          { objectGroup: this.group },
          session,
        ),
      ),
    );
    this.contexts.clear();
    this.delivery.dispose();
    this.lookup?.resolve();
  }
}
