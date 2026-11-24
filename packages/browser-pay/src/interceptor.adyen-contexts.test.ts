import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";

import {
  ADYEN_BLOB_BINDING,
  ADYEN_ENCRYPTED_FIELDS,
  ADYEN_WATCH_WORLD,
} from "./adyen-blobs";
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

  it("awaits a racing watcher install before resuming a waiting target", async () => {
    let releaseAutoAttach!: () => void;
    const autoAttach = new Promise<void>((resolve) => {
      releaseAutoAttach = resolve;
    });
    let releaseScript!: () => void;
    const script = new Promise<void>((resolve) => {
      releaseScript = resolve;
    });
    const targetInfo = {
      targetId: "page",
      type: "page",
      url: "https://shop.example/checkout",
    };
    stub = await startCdpStub((command) => {
      if (command.method === "Target.setAutoAttach") {
        if (command.sessionId === "page-1") return autoAttach;
        if (command.params.autoAttach) {
          stub.emit({
            method: "Target.attachedToTarget",
            params: {
              sessionId: "page-1",
              waitingForDebugger: true,
              targetInfo,
            },
          });
        }
      }
      if (command.method === "Page.addScriptToEvaluateOnNewDocument") {
        return script;
      }
      return undefined;
    });
    const attaching = attachInterceptor(stub.url, {
      placeholder: {
        number: "4242424242424242",
        injectionRef: "inj_watcher_race",
      },
      relay: {
        async relay() {
          throw new Error("unexpected relay");
        },
      },
    });
    try {
      await waitFor(
        () =>
          stub.commands.some(
            (command) =>
              command.method === "Target.setAutoAttach" &&
              command.sessionId === "page-1",
          ),
        "child auto-attach pending",
      );
      stub.emit({
        method: "Target.targetInfoChanged",
        params: { targetInfo },
      });
      await waitFor(
        () =>
          stub.commands.some(
            (command) =>
              command.method === "Page.addScriptToEvaluateOnNewDocument",
          ),
        "watcher script pending",
      );
      releaseAutoAttach();
      // Let enableSession join the install started by the target update.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        stub.commands.some(
          (command) => command.method === "Runtime.runIfWaitingForDebugger",
        ),
      ).toBe(false);
      releaseScript();
      handle = await attaching;
      expect(
        stub.commands.filter(
          (command) => command.method === "Runtime.runIfWaitingForDebugger",
        ),
      ).toHaveLength(1);
      for (const method of [
        "Page.enable",
        "Runtime.enable",
        "Runtime.addBinding",
        "Page.addScriptToEvaluateOnNewDocument",
      ]) {
        expect(
          stub.commands.filter((command) => command.method === method),
        ).toHaveLength(1);
      }
    } finally {
      releaseAutoAttach();
      releaseScript();
      handle = await attaching;
    }
  });

  const paths = ["checkout", "recaptcha/start"];
  it.each(paths)("watches once; relays after /%s", async (initialPath) => {
    const origin = "https://shop.example";
    const relayCalls: RelayRequest[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    // The merchant iframe shares the page's CDP target. Contexts 1 and 2 are
    // the frames' main worlds, 3 another tool's isolated world: none of them
    // may get the binding or the listener. Each frame gets one watch world.
    const contexts = new Map(
      [
        { id: 1, frameId: "top", name: "", isDefault: true },
        { id: 2, frameId: "checkout", name: "", isDefault: true },
        { id: 3, frameId: "checkout", name: "other-tool", isDefault: false },
      ].map((context) => [context.id, context]),
    );
    const worlds = new Map<number, ReturnType<typeof createContext>>();
    const world = (id: number, label: string) =>
      createContext({
        addEventListener: (
          name: string,
          listener: (event: unknown) => void,
        ) => {
          if (name === "message") listeners.set(label, listener);
        },
      });
    for (const { id, frameId } of contexts.values()) {
      worlds.set(id, world(id, `${frameId}:${id}`));
    }
    let bindingWorld: string | undefined;
    let newDocumentScript: string | undefined;
    const bind = (id: number) => {
      worlds.get(id)![ADYEN_BLOB_BINDING] = (payload: string) => {
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
    };
    stub = await startCdpStub((command) => {
      if (command.method === "Target.setAutoAttach" && !command.sessionId) {
        stub.emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId: "page-1",
            waitingForDebugger: false,
            targetInfo: {
              targetId: "page",
              type: "page",
              url: `${origin}/${initialPath}`,
            },
          },
        });
      }
      if (command.method === "Runtime.enable") {
        for (const { id, frameId, name, isDefault } of contexts.values()) {
          stub.emit({
            method: "Runtime.executionContextCreated",
            sessionId: "page-1",
            params: {
              context: { id, origin, name, auxData: { isDefault, frameId } },
            },
          });
        }
      }
      if (command.method === "Runtime.addBinding") {
        bindingWorld = command.params.executionContextName as string;
        for (const [id, { name }] of contexts) {
          if (name === bindingWorld) bind(id);
        }
      }
      if (command.method === "Page.addScriptToEvaluateOnNewDocument") {
        newDocumentScript = command.params.source as string;
      }
      if (command.method === "Page.createIsolatedWorld") {
        const id = 10 + contexts.size;
        const frameId = command.params.frameId as string;
        const name = command.params.worldName as string;
        contexts.set(id, { id, frameId, name, isDefault: false });
        worlds.set(id, world(id, `${frameId}:${name}`));
        if (name === bindingWorld) bind(id);
        stub.emit({
          method: "Runtime.executionContextCreated",
          sessionId: "page-1",
          params: {
            context: {
              id,
              origin,
              name,
              auxData: { isDefault: false, frameId },
            },
          },
        });
        return { executionContextId: id };
      }
      if (command.method === "Runtime.evaluate") {
        if (command.params.expression === "location.origin") {
          return { result: { type: "string", value: origin } };
        }
        const id = command.params.contextId as number;
        runInContext(command.params.expression as string, worlds.get(id)!);
      }
      return undefined;
    });
    handle = await attachInterceptor(stub.url, {
      placeholder: {
        number: "4242424242424242",
        injectionRef: "inj_contexts",
      },
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
    const navigate = (path: string) =>
      stub.emit({
        method: "Target.targetInfoChanged",
        params: {
          targetInfo: {
            targetId: "page",
            type: "page",
            url: `${origin}/${path}`,
          },
        },
      });
    if (initialPath === "recaptcha/start") {
      expect(
        stub.commands.some(
          (command) => command.method === "Runtime.addBinding",
        ),
      ).toBe(false);
      expect(listeners.size).toBe(0);
      navigate("checkout");
      // A second update can arrive while the first arm is still in flight.
      navigate("checkout?ready=1");
    }
    await waitFor(() => listeners.size === 2, "watch listeners installed");
    expect([...listeners.keys()].sort()).toEqual([
      `checkout:${ADYEN_WATCH_WORLD}`,
      `top:${ADYEN_WATCH_WORLD}`,
    ]);
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
      ADYEN_ENCRYPTED_FIELDS.map((field) => [
        field,
        `eyJ.TEST_${field}.aXY.Y2lwaGVy.dGFn`,
      ]),
    );
    const postBlobs = (values: Record<string, string>) => {
      for (const [field, blob] of Object.entries(values)) {
        listeners.get(`checkout:${ADYEN_WATCH_WORLD}`)?.({
          isTrusted: true,
          origin: "https://checkoutshopper-test.adyen.com",
          data: JSON.stringify({
            action: "encryption",
            fieldType: field,
            [field]: [{ encryptedFieldName: field, blob }],
          }),
        });
      }
    };
    postBlobs(blobs);
    const pay = (requestId: string, paymentBlobs = blobs) =>
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId,
          request: {
            method: "POST",
            url: `${origin}/api/payments`,
            headers: { "content-type": "application/json" },
            postData: JSON.stringify({ paymentMethod: paymentBlobs }),
          },
        },
      });
    pay("pay");
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
    navigate("recaptcha/start");
    await waitFor(
      () => stub.commands.some((command) => command.method === "Fetch.disable"),
      "session disarmed",
    );
    const enables = stub.commands.filter(
      (command) => command.method === "Fetch.enable",
    ).length;
    navigate("checkout");
    await waitFor(
      () =>
        stub.commands.filter((command) => command.method === "Fetch.enable")
          .length > enables,
      "session re-armed",
    );
    contexts.clear();
    worlds.clear();
    listeners.clear();
    stub.emit({
      method: "Runtime.executionContextsCleared",
      sessionId: "page-1",
      params: {},
    });
    for (const context of [
      { id: 100, frameId: "top", name: "", isDefault: true },
      { id: 101, frameId: "checkout", name: "", isDefault: true },
      {
        id: 102,
        frameId: "checkout",
        name: ADYEN_WATCH_WORLD,
        isDefault: false,
      },
    ]) {
      const { id, frameId, name, isDefault } = context;
      contexts.set(id, context);
      worlds.set(id, world(id, `${frameId}:${name || id}`));
      if (name === bindingWorld) bind(id);
      stub.emit({
        method: "Runtime.executionContextCreated",
        sessionId: "page-1",
        params: {
          context: { id, origin, name, auxData: { isDefault, frameId } },
        },
      });
      if (name === ADYEN_WATCH_WORLD && newDocumentScript) {
        runInContext(newDocumentScript, worlds.get(id)!);
      }
    }
    const newBlobs = Object.fromEntries(
      ADYEN_ENCRYPTED_FIELDS.map((field) => [
        field,
        `eyJ.REARMED_${field}.aXY.Y2lwaGVy.dGFn`,
      ]),
    );
    postBlobs(newBlobs);
    pay("pay-rearmed", newBlobs);
    await waitFor(
      () =>
        stub.commands.some(
          (command) =>
            command.method === "Fetch.fulfillRequest" &&
            command.params.requestId === "pay-rearmed",
        ),
      "re-armed payment fulfilled",
    );
    expect(relayCalls).toHaveLength(2);
    expect(relayCalls[1].adyen?.placeholderBlobHashes).toEqual(
      Object.fromEntries(
        Object.entries(newBlobs).map(([field, blob]) => [
          field,
          createHash("sha256").update(blob).digest("hex"),
        ]),
      ),
    );
    for (const method of [
      "Page.enable",
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument",
    ]) {
      expect(
        stub.commands.filter(
          (command) =>
            command.sessionId === "page-1" && command.method === method,
        ),
      ).toHaveLength(1);
    }
  });
});
