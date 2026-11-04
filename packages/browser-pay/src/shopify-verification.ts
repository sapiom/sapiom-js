import type { CdpConnection } from "./cdp.js";
import type {
  CheckoutObservation,
  VerificationAdapter,
  VerificationRequest,
  VerificationState,
} from "./verification.js";

const RECEIPT_QUERIES = new Set([
  "b99547c8e17e88f985ec0e11a844dd1305bf14cf70e41ca10954899050ffc567",
  "3ddb1d363e4e875c5659f2aaba308447980240ffc14b31ef90cb8ab7843bc1e5",
]);
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
type Frame = { sessionId: string; frameId: string; url: string };
type Query = Frame & { body: string; receiptId: string };
const json = (body: string) => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};
export const isShopifySubmission = (
  request: Pick<VerificationRequest, "url" | "body">,
) => {
  const url = new URL(request.url);
  return (
    url.pathname === "/checkouts/internal/graphql/persisted" &&
    (json(request.body)?.operationName === "SubmitForCompletion" ||
      url.searchParams.get("operationName") === "SubmitForCompletion")
  );
};
const supportedCReq = (encoded: string) => {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) return false;
  const unpadded = encoded.replace(/=+$/, "");
  const decoded = Buffer.from(encoded, "base64url");
  if (
    decoded.toString("base64url") !== unpadded ||
    (encoded !== unpadded && encoded.length % 4 !== 0)
  )
    return false;
  const message = json(decoded.toString("utf8"));
  if (!message || typeof message !== "object" || Array.isArray(message))
    return false;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return (
    Object.keys(message).sort().join(",") ===
      "acsTransID,challengeWindowSize,messageType,messageVersion,threeDSServerTransID" &&
    message.messageType === "CReq" &&
    ["2.1.0", "2.2.0"].includes(message.messageVersion) &&
    ["01", "02", "03", "04", "05"].includes(message.challengeWindowSize) &&
    typeof message.acsTransID === "string" &&
    typeof message.threeDSServerTransID === "string" &&
    uuid.test(message.acsTransID) &&
    uuid.test(message.threeDSServerTransID)
  );
};
const money = (value: unknown) => {
  const amount = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
  const [whole, fraction = ""] = amount.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
};

/** Observes the supported Shopify protocol on the caller's existing CDP connection. */
export class ShopifyVerification implements VerificationAdapter {
  private cardSession?: string;
  private submitted = false;
  private checkout?: Frame;
  private callback?: Frame;
  private query?: Query;

  constructor(
    private readonly cdp: Pick<CdpConnection, "send">,
    private readonly state: () => VerificationState | undefined,
    private readonly parentSession: (
      sessionId: string,
      parentFrameId?: string,
    ) => string | undefined = () => undefined,
  ) {}

  relayed(response: { body: string }) {
    if (this.cardSession) return;
    const id = json(response.body)?.id;
    if (typeof id === "string" && id.length > 0 && id.length <= 255)
      this.cardSession = id;
  }

  async inspect(request: VerificationRequest) {
    const state = this.state();
    if (!state) return "continue" as const;
    const url = new URL(request.url);
    const sameMerchant = url.origin === state.merchantOrigin;
    const body = json(request.body);
    if (
      sameMerchant &&
      url.pathname === "/checkouts/internal/graphql/persisted"
    ) {
      if (isShopifySubmission(request)) {
        const lines = body?.variables?.input?.payment?.paymentLines;
        if (state.challengeCaptured || state.launchClaimed)
          return "block" as const;
        // Shopify retains its native retry behavior until Sapiom captures the bank step.
        if (
          this.submitted ||
          !this.cardSession ||
          request.method !== "POST" ||
          body?.operationName !== "SubmitForCompletion" ||
          !Array.isArray(lines) ||
          lines.length !== 1 ||
          lines[0]?.paymentMethod?.directPaymentMethod?.sessionId !==
            this.cardSession
        )
          return "fallback" as const;
        // Claim before continuing the original mutation, including ambiguous network outcomes.
        this.submitted = true;
        this.checkout = await this.checkoutFrame(
          request,
          state.merchantOrigin,
        ).catch(() => undefined);
        if (!this.checkout) return "fallback" as const;
      }
      if (
        this.submitted &&
        this.checkout?.sessionId === request.sessionId &&
        this.checkout.frameId === request.frameId &&
        request.frameId &&
        request.method === "POST" &&
        url.search === "?operationName=PollForReceipt" &&
        body?.operationName === "PollForReceipt" &&
        RECEIPT_QUERIES.has(body.id) &&
        Object.keys(body).sort().join() === "id,operationName,variables" &&
        body.variables &&
        Object.keys(body.variables).sort().join() ===
          "receiptId,sessionToken" &&
        [body.variables.receiptId, body.variables.sessionToken].every(
          (v) => typeof v === "string" && v.length > 0 && v.length <= 2048,
        )
      ) {
        if (!this.query)
          this.query = {
            sessionId: request.sessionId,
            frameId: request.frameId,
            url: url.href,
            body: request.body,
            receiptId: body.variables.receiptId,
          };
      }
    }
    if (
      sameMerchant &&
      this.submitted &&
      request.frameId &&
      request.method === "GET" &&
      url.pathname === "/payments_api/redirect/show" &&
      !this.callback &&
      this.checkout &&
      (await this.descendant(this.checkout, request).catch(() => false))
    ) {
      this.callback = {
        sessionId: request.sessionId,
        frameId: request.frameId,
        url: url.href,
      };
    }
    const form = body === null ? new URLSearchParams(request.body) : null;
    const formChallenge = form?.has("creq") ?? false;
    const jsonChallenge =
      body !== null &&
      typeof body === "object" &&
      (Object.prototype.hasOwnProperty.call(body, "creq") ||
        body.messageType === "CReq");
    if (
      sameMerchant ||
      request.method !== "POST" ||
      (!formChallenge && !jsonChallenge)
    )
      return "continue" as const;
    if (state.challengeCaptured || state.launchClaimed) return "block" as const;
    if (jsonChallenge) return "fallback" as const;
    // Reject unsupported material and preserve accepted bank protocol data exactly.
    if (
      request.url.length > 2048 ||
      request.body.length > 8192 ||
      [...request.url].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 32 || code === 127;
      }) ||
      !form ||
      [...form.keys()].join(",") !== "creq" ||
      !supportedCReq(form.get("creq") ?? "") ||
      !this.submitted ||
      !this.cardSession ||
      !this.callback ||
      !request.frameId ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !(await this.descendant(this.callback, request).catch(() => false))
    )
      return "fallback" as const;
    return { capture: { url: request.url, body: request.body } };
  }

  async continuation(): Promise<(() => Promise<void>) | null> {
    const frame = this.callback;
    const state = this.state();
    if (!frame || !state || !state.launchClaimed) return null;
    const result = await this.evaluate(
      frame,
      `async () => {
      if (location.href !== ${JSON.stringify(frame.url)}) return null;
      let target = location.href;
      const hint = document.getElementById('iframe-3ds')?.getAttribute('data-authentication-poll-url');
      if (hint != null) {
        const original = new URL(location.href);
        const poll = new URL(hint, original);
        if (poll.origin !== original.origin || poll.pathname !== '/payments_api/redirect/poll' ||
            poll.username || poll.password || poll.hash || poll.href.length > 2048 ||
            [...poll.searchParams.keys()].sort().join(',') !== 'origin,payment_id' ||
            [...original.searchParams.keys()].sort().join(',') !== 'origin,payment_id' ||
            !poll.searchParams.get('payment_id') || !poll.searchParams.get('origin') ||
            ['origin', 'payment_id'].some(key => poll.searchParams.get(key) !== original.searchParams.get(key))) return null;
        target = poll.href;
      }
      const response = await fetch(target, {
        credentials: 'include', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(10000)
      });
      if (response.status !== 200) return null;
      return readText(response, 1024);
    }`,
    );
    // An early Check sees a redirect or challenge HTML. Never execute returned merchant HTML.
    if (
      typeof result !== "string" ||
      result.replace(/\s/g, "").replace(/"/g, "'") !==
        "<script>window.top.postMessage({type:'3ds_completed'},'*');</script>"
    )
      return null;
    return async () => {
      // VerificationSession commits the one-use continuation claim before this fixed message.
      await this.evaluate(
        frame,
        `() => {
        if (location.href !== ${JSON.stringify(frame.url)}) return false;
        window.top.postMessage({type: '3ds_completed'}, ${JSON.stringify(state.merchantOrigin)});
        return true;
      }`,
      );
    };
  }

  async reconcile(
    state: VerificationState,
  ): Promise<CheckoutObservation | null> {
    const query = this.query;
    if (!query || !this.cardSession) return null;
    const payload = await this.evaluate(
      query,
      `async () => {
      if (location.origin !== ${JSON.stringify(state.merchantOrigin)}) return null;
      const response = await fetch(${JSON.stringify(query.url)}, {
        method: 'POST', credentials: 'include', redirect: 'error',
        headers: {'content-type': 'application/json', accept: 'application/json'},
        body: ${JSON.stringify(query.body)}, signal: AbortSignal.timeout(10000)
      });
      if (response.status !== 200 || !response.headers.get('content-type')?.includes('json')) return null;
      const text = await readText(response, 262144);
      return text === null ? null : JSON.parse(text);
    }`,
    );
    const receipt = (payload as any)?.data?.receipt;
    const lines = receipt?.purchaseOrder?.payment?.paymentLines;
    if (
      !receipt ||
      receipt.id !== query.receiptId ||
      !Array.isArray(lines) ||
      lines.length !== 1 ||
      lines[0]?.paymentMethod?.sessionId !== this.cardSession
    )
      return null;
    const amount = money(receipt.paymentDetails?.paymentAmount?.amount);
    const currency = receipt.paymentDetails?.paymentAmount?.currencyCode;
    if (amount !== state.total.amount || currency !== state.total.currency)
      return null;
    const outcome =
      receipt.__typename === "FailedReceipt"
        ? "failed"
        : receipt.__typename === "ProcessedReceipt" &&
            receipt.orderCreationStatus?.__typename ===
              "OrderCreationSucceeded" &&
            receipt.orderIdentity?.id
          ? "confirmed"
          : "unknown";
    if (outcome === "unknown") return null;
    const confirmation = receipt.orderIdentity?.buyerIdentifier;
    return {
      outcome,
      cardSession: this.cardSession,
      amount,
      currency,
      ...(typeof confirmation === "string" &&
        /^[A-Z0-9]{6,14}$/.test(confirmation) && { confirmation }),
    };
  }

  private async descendant(frame: Frame, request: VerificationRequest) {
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
    if (!callback || callback.frame.url !== frame.url) return false;
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

  private async checkoutFrame(
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

  private async evaluate(frame: Frame, fn: string): Promise<unknown> {
    const world = (await this.cdp.send(
      "Page.createIsolatedWorld",
      {
        frameId: frame.frameId,
        worldName: "sapiom-checkout-verification",
      },
      frame.sessionId,
    )) as any;
    const evaluated = (await this.cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => { const readText = ${READ_VERIFICATION_TEXT}; return (${fn})(); })()`,
        contextId: world.executionContextId,
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
