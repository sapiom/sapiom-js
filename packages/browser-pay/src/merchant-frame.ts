import type { CdpConnection } from "./cdp.js";
import type { VerificationRequest } from "./verification.js";

export const READ_VERIFICATION_TEXT = `async (response, limit) => {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}`;
export type Frame = { sessionId: string; frameId: string; url: string };

/** Existing merchant frame ancestry and bounded observation on the caller-owned connection. */
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
    origin: string,
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
      const tree = (await this.cdp.send(
        "Page.getFrameTree",
        {},
        sessionId,
      )) as any;
      const frames = new Map<string, any>();
      const collect = (node: any, parentId?: string) => {
        if (typeof node?.frame?.id !== "string") return;
        frames.set(node.frame.id, {
          ...node.frame,
          parentId: parentId ?? node.frame.parentId,
        });
        for (const child of node.childFrames ?? [])
          collect(child, node.frame.id);
      };
      collect(tree.frameTree);
      const seen = new Set<string>();
      while (frameId && !seen.has(frameId)) {
        seen.add(frameId);
        const frame = frames.get(frameId);
        if (!frame) break;
        if (
          typeof frame.url === "string" &&
          new URL(frame.url).origin === origin
        )
          return { sessionId, frameId, url: frame.url };
        frameId = frame.parentId;
      }
      sessionId = this.parentSession(sessionId, frameId);
    }
  }

  protected async descendant(
    frame: Frame,
    request: VerificationRequest,
    exactUrl = true,
  ) {
    const result = (await this.cdp.send(
      "Page.getFrameTree",
      {},
      frame.sessionId,
    )) as any;
    const find = (tree: any): any =>
      tree?.frame?.id === frame.frameId
        ? tree
        : tree?.childFrames?.map(find).find(Boolean);
    const callback = find(result?.frameTree);
    if (!callback || typeof callback.frame.url !== "string") return false;
    if (
      exactUrl
        ? callback.frame.url !== frame.url
        : new URL(callback.frame.url).origin !== new URL(frame.url).origin
    )
      return false;
    const parents = new Map<string, string>();
    const collect = (tree: any, parent?: string) => {
      if (typeof tree?.frame?.id !== "string") return;
      const id = tree.frame.id;
      const parentId = parent ?? tree.frame.parentId;
      if (typeof parentId === "string") parents.set(id, parentId);
      for (const child of tree.childFrames ?? []) collect(child, id);
    };
    collect(result.frameTree);
    const contains = () => {
      const seen = new Set<string>();
      let id = request.frameId;
      while (id && !seen.has(id)) {
        if (id === frame.frameId) return true;
        seen.add(id);
        id = parents.get(id);
      }
      return false;
    };
    if (contains()) return true;
    // OOP iframe roots retain their browser-owned parent frame ID in their own session.
    const seen = new Set<string>();
    let sessionId: string | undefined = request.sessionId;
    while (sessionId && sessionId !== frame.sessionId && seen.size < 32) {
      if (seen.has(sessionId)) return false;
      seen.add(sessionId);
      const tree = (await this.cdp.send(
        "Page.getFrameTree",
        {},
        sessionId,
      )) as any;
      collect(tree?.frameTree);
      if (contains()) return true;
      sessionId = this.parentSession(
        sessionId,
        tree?.frameTree?.frame?.parentId,
      );
    }
    return false;
  }

  protected async checkoutFrame(
    request: VerificationRequest,
    origin: string,
  ): Promise<Frame | undefined> {
    if (!request.frameId) return;
    const result = (await this.cdp.send(
      "Page.getFrameTree",
      {},
      request.sessionId,
    )) as any;
    const find = (tree: any): any =>
      tree?.frame?.id === request.frameId
        ? tree.frame
        : tree?.childFrames?.map(find).find(Boolean);
    const frame = find(result?.frameTree);
    if (!frame?.url || new URL(frame.url).origin !== origin) return;
    return {
      frameId: request.frameId,
      sessionId: request.sessionId,
      url: frame.url,
    };
  }

  protected async evaluate(
    frame: Frame,
    fn: string,
    args: unknown[],
  ): Promise<unknown> {
    const world = (await this.cdp.send(
      "Page.createIsolatedWorld",
      {
        frameId: frame.frameId,
        worldName: "sapiom-checkout-verification",
      },
      frame.sessionId,
    )) as any;
    const evaluated = (await this.cdp.send(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: `function(...args) { const readText = ${READ_VERIFICATION_TEXT}; return (${fn})(...args); }`,
        executionContextId: world.executionContextId,
        arguments: args.map((value) => ({ value })),
        awaitPromise: true,
        returnByValue: true,
      },
      frame.sessionId,
      15000,
    )) as any;
    if (evaluated.exceptionDetails)
      throw new Error("Merchant observation unavailable");
    return evaluated.result?.value;
  }
}
