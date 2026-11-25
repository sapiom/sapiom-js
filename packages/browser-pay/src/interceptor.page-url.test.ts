import type { RelayRequest } from "./contract";
import { attachInterceptor, type InterceptorHandle } from "./interceptor";
import {
  startCdpStub,
  waitFor,
  type CdpCommand,
  type CdpStub,
} from "../test/cdp-stub";

const NUMBER = "4242424242424242";
const PAGE_ORIGIN = "https://shop.example";
const CHECKOUT_PATH = "/checkouts/cn/tok_test/en-us";
const ORIGIN_EXPRESSION = "location.origin";
const PAGE_URL_EXPRESSION = "location.origin + location.pathname";
const ANCESTOR_EXPRESSION =
  "location.ancestorOrigins[location.ancestorOrigins.length - 1]";

type Evaluate = (expression: string) => unknown;

function evaluated(value: string) {
  return { result: { type: "string", value } };
}

describe("relay request pageUrl", () => {
  let stub: CdpStub | undefined;
  let handle: InterceptorHandle | undefined;

  afterEach(async () => {
    await handle?.detach();
    await stub?.close();
    handle = undefined;
    stub = undefined;
  });

  /**
   * Pauses one placeholder request in `pausedIn` and returns what the relay
   * was asked. `targets` attach in order; a `page` target is the top page.
   */
  async function relayRequestFor(
    evaluate: Evaluate,
    targets: { sessionId: string; type: string; url: string }[],
    pausedIn: string,
  ): Promise<RelayRequest> {
    const calls: RelayRequest[] = [];
    stub = await startCdpStub((command: CdpCommand) => {
      if (command.method === "Target.getTargets") return { targetInfos: [] };
      if (command.method === "Runtime.evaluate") {
        return evaluate(command.params.expression as string);
      }
      return undefined;
    });
    handle = await attachInterceptor(stub.url, {
      placeholder: { number: NUMBER, injectionRef: "inj_page_url" },
      relay: {
        async relay(request) {
          calls.push(request);
          return { outcome: "refused", reason: "checkout_mismatch" };
        },
      },
    });
    for (const target of targets) {
      stub.emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: target.sessionId,
          waitingForDebugger: true,
          targetInfo: {
            targetId: `target-${target.sessionId}`,
            type: target.type,
            url: target.url,
          },
        },
      });
    }
    await waitFor(
      () =>
        targets.every((target) =>
          stub!.commands.some(
            (command) =>
              command.method === "Fetch.enable" &&
              command.sessionId === target.sessionId,
          ),
        ),
      "Fetch.enable",
    );
    stub.emit({
      method: "Fetch.requestPaused",
      sessionId: pausedIn,
      params: {
        requestId: "req-card",
        request: {
          url: "https://checkout.pci.example/sessions",
          method: "POST",
          headers: { "content-type": "application/json" },
          postData: JSON.stringify({ credit_card: { number: NUMBER } }),
        },
      },
    });
    await waitFor(() => calls.length === 1, "relay call");
    return calls[0]!;
  }

  const page = (url: string) => [{ sessionId: "page-1", type: "page", url }];

  it("sends the top page's origin and path read from the page", async () => {
    const request = await relayRequestFor(
      (expression) => {
        if (expression === ORIGIN_EXPRESSION) return evaluated(PAGE_ORIGIN);
        if (expression === PAGE_URL_EXPRESSION) {
          return evaluated(`${PAGE_ORIGIN}${CHECKOUT_PATH}`);
        }
        return undefined;
      },
      page(`${PAGE_ORIGIN}/`),
      "page-1",
    );
    expect(request.pageOrigin).toBe(PAGE_ORIGIN);
    expect(request.pageUrl).toBe(`${PAGE_ORIGIN}${CHECKOUT_PATH}`);
  });

  it("falls back to the page target's URL without its query or fragment", async () => {
    const request = await relayRequestFor(
      (expression) => {
        if (expression === PAGE_URL_EXPRESSION) {
          throw new Error("context gone");
        }
        return undefined;
      },
      page(
        `https://user_test:pass_test@shop.example${CHECKOUT_PATH}?key=key_test#step`,
      ),
      "page-1",
    );
    expect(request.pageOrigin).toBe(PAGE_ORIGIN);
    expect(request.pageUrl).toBe(`${PAGE_ORIGIN}${CHECKOUT_PATH}`);
  });

  it("leaves pageUrl out when the page reads off pageOrigin", async () => {
    const request = await relayRequestFor(
      (expression) => {
        if (expression === ORIGIN_EXPRESSION) return evaluated(PAGE_ORIGIN);
        if (expression === PAGE_URL_EXPRESSION) {
          return evaluated(`https://other.example${CHECKOUT_PATH}`);
        }
        return undefined;
      },
      page(`${PAGE_ORIGIN}${CHECKOUT_PATH}`),
      "page-1",
    );
    expect(request.pageOrigin).toBe(PAGE_ORIGIN);
    expect("pageUrl" in request).toBe(false);
  });

  it("leaves pageUrl out when its path holds the placeholder", async () => {
    const request = await relayRequestFor(
      (expression) => {
        if (expression === ORIGIN_EXPRESSION) return evaluated(PAGE_ORIGIN);
        if (expression === PAGE_URL_EXPRESSION) {
          return evaluated(`${PAGE_ORIGIN}/pay/4242-4242-4242-4242`);
        }
        return undefined;
      },
      page(`${PAGE_ORIGIN}/`),
      "page-1",
    );
    expect(request.pageOrigin).toBe(PAGE_ORIGIN);
    expect("pageUrl" in request).toBe(false);
  });

  it("leaves pageUrl out when only the frame's ancestorOrigins names the page", async () => {
    const request = await relayRequestFor(
      (expression) => {
        if (expression === ANCESTOR_EXPRESSION) return evaluated(PAGE_ORIGIN);
        return undefined;
      },
      [
        {
          sessionId: "frame-1",
          type: "iframe",
          url: "https://checkout.pci.example/frame",
        },
      ],
      "frame-1",
    );
    expect(request.pageOrigin).toBe(PAGE_ORIGIN);
    expect("pageUrl" in request).toBe(false);
  });
});
