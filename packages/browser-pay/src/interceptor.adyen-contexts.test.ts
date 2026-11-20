import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";

import { ADYEN_BLOB_BINDING, ADYEN_ENCRYPTED_FIELDS } from "./adyen-blobs";
import type { RelayRequest } from "./contract";
import { attachInterceptor, type InterceptorHandle } from "./interceptor";
import { startCdpStub, waitFor, type CdpStub } from "../test/cdp-stub";

describe("Adyen observations in existing documents", () => {
  let stub: CdpStub;
  let handle: InterceptorHandle | undefined;

  afterEach(async () => {
    await handle?.detach();
    await stub?.close();
    handle = undefined;
  });

  it("relays hashes posted to an already-loaded same-origin checkout iframe", async () => {
    const origin = "https://shop.example";
    const relayCalls: RelayRequest[] = [];
    const listeners = new Map<number, (event: unknown) => void>();
    // The merchant iframe shares the page's CDP target. Its isolated world
    // must not receive a second observer for the same document.
    const worlds = new Map(
      [1, 2, 3].map((id) => [
        id,
        createContext({
          addEventListener: (
            name: string,
            listener: (event: unknown) => void,
          ) => {
            if (name === "message") listeners.set(id, listener);
          },
        }),
      ]),
    );
    stub = await startCdpStub((command) => {
      if (command.method === "Target.setAutoAttach" && !command.sessionId) {
        stub.emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId: "page-1",
            waitingForDebugger: false,
            targetInfo: { targetId: "page", type: "page", url: `${origin}/` },
          },
        });
      }
      if (command.method === "Runtime.enable") {
        for (const id of worlds.keys()) {
          stub.emit({
            method: "Runtime.executionContextCreated",
            sessionId: "page-1",
            params: {
              context: {
                id,
                origin,
                auxData: {
                  isDefault: id !== 3,
                  frameId: id === 1 ? "top" : "checkout",
                },
              },
            },
          });
        }
      }
      if (command.method === "Runtime.addBinding") {
        for (const [id, world] of worlds) {
          world[ADYEN_BLOB_BINDING] = (payload: string) => {
            stub.emit({
              method: "Runtime.bindingCalled",
              sessionId: "page-1",
              params: {
                name: ADYEN_BLOB_BINDING,
                payload,
                executionContextId: id,
              },
            });
          };
        }
      }
      if (command.method === "Runtime.evaluate") {
        if (command.params.expression === "location.origin") {
          return { result: { type: "string", value: origin } };
        }
        const id = (command.params.contextId as number | undefined) ?? 1;
        runInContext(command.params.expression as string, worlds.get(id)!);
      }
      return undefined;
    });
    handle = await attachInterceptor(stub.url, {
      placeholder: { number: "4242424242424242", injectionRef: "inj_contexts" },
      relay: {
        async relay(request) {
          relayCalls.push(request);
          return {
            outcome: "relayed",
            response: { status: 200, headers: {}, body: "{}" },
          };
        },
      },
    });
    expect([...listeners.keys()].sort()).toEqual([1, 2]);
    stub.emit({
      method: "Network.requestWillBeSent",
      sessionId: "page-1",
      params: {
        requestId: "key-request",
        request: {
          method: "GET",
          url: "https://checkoutshopper-test.adyen.com/checkoutshopper/v1/clientKeys/test_CONTEXTKEY1",
          headers: {},
        },
      },
    });
    const blobs = Object.fromEntries(
      ADYEN_ENCRYPTED_FIELDS.map((field) => [field, `eyJ.TEST_${field}`]),
    );
    for (const [field, blob] of Object.entries(blobs)) {
      listeners.get(2)?.({
        isTrusted: true,
        origin: "https://checkoutshopper-test.adyen.com",
        data: JSON.stringify({
          action: "encryption",
          fieldType: field,
          [field]: [{ encryptedFieldName: field, blob }],
        }),
      });
    }
    stub.emit({
      method: "Fetch.requestPaused",
      sessionId: "page-1",
      params: {
        requestId: "pay",
        request: {
          method: "POST",
          url: `${origin}/api/payments`,
          headers: { "content-type": "application/json" },
          postData: JSON.stringify({ paymentMethod: blobs }),
        },
      },
    });
    await waitFor(
      () =>
        stub.commands.some(
          (command) =>
            command.method === "Fetch.fulfillRequest" ||
            command.method === "Fetch.failRequest",
        ),
      "payment settled",
    );

    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0].adyen?.placeholderBlobHashes).toEqual(
      Object.fromEntries(
        Object.entries(blobs).map(([field, blob]) => [
          field,
          createHash("sha256").update(blob).digest("hex"),
        ]),
      ),
    );
  });
});
