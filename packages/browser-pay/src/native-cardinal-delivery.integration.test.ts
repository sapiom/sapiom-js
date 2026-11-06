import { existsSync } from "node:fs";
import { chromium } from "playwright";
import type { CdpConnection } from "./cdp";
import { NativeCardinalDelivery } from "./native-cardinal-delivery";

const executablePath = [
  process.env.CHROME_PATH,
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  chromium.executablePath(),
].find((path): path is string => Boolean(path && existsSync(path)));

(executablePath ? it : it.skip)(
  "acknowledges the original native promise before its merchant continuation navigates",
  async () => {
    const browser = await chromium.launch({
      executablePath,
      args: ["--no-sandbox"],
    });
    let delivery: NativeCardinalDelivery | undefined;
    try {
      const page = await browser.newPage();
      await page.goto("about:blank");
      await page.evaluate(`(() => {
        let resolve, reject;
        const pending = Object.assign(new Promise((yes, no) => { resolve = yes; reject = no; }), {
          resolve: value => resolve(value), reject: error => reject(error),
        });
        const method = { nonce: 'upgraded-original' };
        const framework = {
          _verifyCardPromisePlus: pending, _lookupPaymentMethod: method,
          _client: { request: async () => ({ paymentMethod: { nonce: 'authenticated' }, threeDSecureInfo: {} }) },
        };
        Object.assign(globalThis, {
          framework, pending, method, cleanup: () => {},
          handler: (_payload, jwt) => {
            framework._client.request({
              endpoint: 'payment_methods/upgraded-original/three_d_secure/authenticate_from_jwt',
              data: { jwt, paymentMethodNonce: method.nonce },
            }).then(value => pending.resolve(value), error => pending.reject(error));
          },
        });
        pending.then(() => location.replace('about:blank?acknowledged=' + Boolean(globalThis.returnAcknowledged)));
      })()`);
      const cdp = await page.context().newCDPSession(page);
      let contextId = 0;
      cdp.on("Runtime.executionContextCreated", ({ context }) => {
        if ((context.auxData as { isDefault?: boolean } | undefined)?.isDefault)
          contextId = context.id;
      });
      await cdp.send("Runtime.enable");
      expect(contextId).toBeGreaterThan(0);
      const connection: Pick<CdpConnection, "send" | "onEvent"> = {
        async send(method, params = {}) {
          const result = await cdp.send(method as never, params as never);
          if (method === "Runtime.addBinding") {
            await cdp.send("Runtime.evaluate", {
              expression: `((name) => {
                const binding = globalThis[name];
                globalThis[name] = token => { globalThis.returnAcknowledged = true; return binding(token); };
              })(${JSON.stringify(params.name)})`,
              contextId,
            });
          }
          return result;
        },
        onEvent(listener) {
          const receive = (params: {
            name: string;
            payload: string;
            executionContextId: number;
          }) => {
            listener({
              method: "Runtime.bindingCalled",
              sessionId: "merchant",
              params,
            });
          };
          cdp.on("Runtime.bindingCalled", receive);
          return () => {
            cdp.off("Runtime.bindingCalled", receive);
          };
        },
      };
      const reference = async (name: string) => {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: `globalThis.${name}`,
          contextId,
        });
        expect(result.objectId).toBeDefined();
        return result.objectId!;
      };
      const target = {
        frame: {
          sessionId: "merchant",
          frameId: "checkout",
          url: "about:blank",
        },
        context: { id: contextId, epoch: 1 },
        framework: await reference("framework"),
        handler: await reference("handler"),
        cleanup: await reference("cleanup"),
        pending: await reference("pending"),
        method: await reference("method"),
      };
      const jwt = [
        { alg: "HS256" },
        {
          exp: Math.floor(Date.now() / 1000) + 60,
          Payload: { ActionCode: "SUCCESS" },
        },
      ]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .concat("signature")
        .join(".");
      delivery = new NativeCardinalDelivery(connection);
      await delivery.deliver(
        target,
        { protocol: "braintree_cardinal", jwt },
        new Date(Date.now() + 60_000).toISOString(),
      );
      await page.waitForURL(/about:blank\?acknowledged=/, { timeout: 5000 });
      expect(page.url()).toBe("about:blank?acknowledged=true");
    } finally {
      delivery?.dispose();
      await browser.close();
    }
  },
  20_000,
);
