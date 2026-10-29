/**
 * What an agent platform runs: open a Sapiom browser (captcha solving is the
 * capability's own flag), attach the interceptor to the returned CDP URL, and
 * let the agent's own driver use that same URL.
 *
 * A raw CDP URL works the same way: `attachInterceptor(process.env.CDP_URL, …)`.
 *
 *   SAPIOM_API_KEY=… TRANSACTION_ID=… INJECTION_REF=… PLACEHOLDER_NUMBER=… \
 *   npx tsx examples/attach.ts
 *
 * Set PROFILE_ID=shopify-card-vault for a Shopify checkout; leave it unset for
 * any other checkout.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@sapiom/tools";
import {
  attachInterceptor,
  httpPaymentRelay,
  type InterceptorHandle,
} from "../src/index.js";

const log = {
  info(message: string, fields?: Readonly<Record<string, string | number>>) {
    process.stdout.write(`${message} ${JSON.stringify(fields ?? {})}\n`);
  },
  warn(message: string, fields?: Readonly<Record<string, string | number>>) {
    process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`);
  },
};

async function main(): Promise<void> {
  const apiKey = process.env.SAPIOM_API_KEY;
  if (!apiKey) throw new Error("SAPIOM_API_KEY is required");
  const transactionId = process.env.TRANSACTION_ID;
  const injectionRef = process.env.INJECTION_REF;
  const number = process.env.PLACEHOLDER_NUMBER;
  const profileId = process.env.PROFILE_ID || undefined;
  if (!transactionId || !injectionRef || !number) {
    throw new Error(
      "TRANSACTION_ID, INJECTION_REF, and PLACEHOLDER_NUMBER are required",
    );
  }

  const sapiom = createClient({ apiKey });
  const session = await sapiom.browserAutomation.sessions.createManaged({
    idempotencyKey: randomUUID(),
    recording: false,
    captchaSolver: true,
    proxy: true,
    stealth: true,
    headless: false,
  });
  let handle: InterceptorHandle | undefined;
  const shutdown = async () => {
    await handle?.detach()?.catch(() => {});
    await sapiom.browserAutomation.sessions
      .closeManaged(session.sessionId)
      .catch(() => {});
    await sapiom.shutdown().catch(() => {});
  };
  try {
    handle = await attachInterceptor(session.cdpUrl, {
      relay: httpPaymentRelay({
        baseUrl: process.env.SAPIOM_BASE_URL ?? "https://api.sapiom.ai",
        apiKey,
        transactionId,
      }),
      ...(profileId && { profileId }),
      placeholder: {
        number,
        injectionRef,
      },
      logger: log,
    });
    const last4 = number.replace(/\D/g, "").slice(-4);
    log.info("interceptor attached", { last4 });
    handle.on((event) => {
      if (event.type === "relayed")
        log.info("relayed", { status: event.status });
      else if (event.type === "refused") {
        log.warn("refused", { reason: event.reason });
      } else if (event.type === "failed") {
        log.warn("failed", { reason: event.reason });
      }
    });
    process.on("SIGINT", () => {
      void shutdown().finally(() => process.exit(0));
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "attach failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
