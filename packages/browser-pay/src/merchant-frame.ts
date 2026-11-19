import type { CdpConnection } from "./cdp.js";
import { isRecord } from "./guards.js";
import type { VerificationRequest } from "./verification-types.js";

export type Frame = { sessionId: string; frameId: string; url: string };
type TreeFrame = { id: string; parentId?: string; url: string };

function frames(value: unknown): Map<string, TreeFrame> {
  const result = new Map<string, TreeFrame>();
  const collect = (node: unknown, parentId?: string, depth = 0) => {
    if (depth >= 32 || !isRecord(node) || !isRecord(node.frame)) return;
    const frame = node.frame;
    if (typeof frame.id !== "string" || typeof frame.url !== "string") return;
    result.set(frame.id, {
      id: frame.id,
      parentId:
        parentId ??
        (typeof frame.parentId === "string" ? frame.parentId : undefined),
      // CDP separates the fragment from frame.url, including on Stripe trampolines.
      url:
        frame.url +
        (typeof frame.urlFragment === "string" ? frame.urlFragment : ""),
    });
    if (Array.isArray(node.childFrames))
      for (const child of node.childFrames) collect(child, frame.id, depth + 1);
  };
  if (isRecord(value)) collect(value.frameTree);
  return result;
}

function origin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Frame ancestry and isolated-world delivery on the caller-owned browser. */
export class MerchantFrames {
  constructor(
    protected readonly cdp: Pick<CdpConnection, "send">,
    protected readonly parentSession: (
      sessionId: string,
      parentFrameId?: string,
    ) => string | undefined = () => undefined,
  ) {}

  protected async merchantAncestor(
    request: { sessionId: string; frameId?: string },
    merchantOrigin: string,
  ): Promise<Frame | undefined> {
    let sessionId: string | undefined = request.sessionId;
    let frameId = request.frameId;
    const sessions = new Set<string>();
    while (
      sessionId &&
      frameId &&
      sessions.size < 32 &&
      !sessions.has(sessionId)
    ) {
      sessions.add(sessionId);
      const tree = frames(
        await this.cdp.send("Page.getFrameTree", {}, sessionId),
      );
      const seen = new Set<string>();
      while (frameId && !seen.has(frameId)) {
        seen.add(frameId);
        const frame = tree.get(frameId);
        if (!frame) break;
        if (origin(frame.url) === merchantOrigin)
          return { sessionId, frameId, url: frame.url };
        frameId = frame.parentId;
      }
      sessionId = this.parentSession(sessionId, frameId);
    }
  }

  protected async descendant(
    frame: Frame,
    request: Pick<VerificationRequest, "sessionId" | "frameId">,
    exactUrl = true,
  ): Promise<boolean> {
    const tree = frames(
      await this.cdp.send("Page.getFrameTree", {}, frame.sessionId),
    );
    const callback = tree.get(frame.frameId);
    if (
      !callback ||
      (exactUrl
        ? callback.url !== frame.url
        : origin(callback.url) !== origin(frame.url))
    )
      return false;
    const contains = () => {
      const seen = new Set<string>();
      let id = request.frameId;
      while (id && !seen.has(id)) {
        if (id === frame.frameId) return true;
        seen.add(id);
        id = tree.get(id)?.parentId;
      }
      return false;
    };
    if (contains()) return true;
    const seen = new Set<string>();
    let sessionId: string | undefined = request.sessionId;
    while (
      sessionId &&
      sessionId !== frame.sessionId &&
      seen.size < 32 &&
      !seen.has(sessionId)
    ) {
      seen.add(sessionId);
      const children = frames(
        await this.cdp.send("Page.getFrameTree", {}, sessionId),
      );
      for (const [id, child] of children) tree.set(id, child);
      if (contains()) return true;
      sessionId = this.parentSession(
        sessionId,
        children.values().next().value?.parentId,
      );
    }
    return false;
  }

  protected async evaluate(
    frame: Frame,
    fn: string,
    args: unknown[],
  ): Promise<unknown> {
    const world = await this.cdp.send(
      "Page.createIsolatedWorld",
      {
        frameId: frame.frameId,
        worldName: "sapiom-checkout-verification",
      },
      frame.sessionId,
    );
    if (!isRecord(world) || typeof world.executionContextId !== "number")
      throw new Error("Merchant observation unavailable");
    const evaluated = await this.cdp.send(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: `function(...args) { return (${fn})(...args); }`,
        executionContextId: world.executionContextId,
        arguments: args.map((value) => ({ value })),
        awaitPromise: true,
        returnByValue: true,
      },
      frame.sessionId,
      15000,
    );
    if (!isRecord(evaluated) || evaluated.exceptionDetails)
      throw new Error("Merchant observation unavailable");
    return isRecord(evaluated.result) ? evaluated.result.value : undefined;
  }
}
