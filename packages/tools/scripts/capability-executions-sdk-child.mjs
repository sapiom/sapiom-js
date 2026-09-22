// Public built artifact only. Fixture credentials arrive over private IPC, never argv/files.
import { createHash } from "node:crypto";
import { createClient } from "../dist/esm/index.js";

function loopback(base) {
  const url = new URL(base);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "SDK fixture requires a credential-free loopback HTTP base.",
    );
}

process.once("message", async (message) => {
  const history = [];
  let client;
  let saved;
  try {
    loopback(message.baseUrl);
    let drop = Boolean(message.dropFirstSubmitResponse);
    client = createClient({
      apiKey: message.apiKey,
      coreBaseUrl: message.baseUrl,
      fetch: async (url, init) => {
        const entry = {
          method: init?.method ?? "GET",
          path: new URL(String(url)).pathname,
          submissionKey: new Headers(init?.headers).get("Idempotency-Key"),
          bodyHash:
            typeof init?.body === "string"
              ? createHash("sha256").update(init.body).digest("hex")
              : undefined,
        };
        history.push(entry);
        const response = await fetch(url, init);
        entry.status = response.status;
        if (drop && init?.method === "POST") {
          drop = false;
          await response.text(); // Core accepted and fully sent a receipt before the simulated loss.
          entry.receiptDropped = true;
          throw new Error("Fixture dropped the acceptance response.");
        }
        return response;
      },
    });
    let result;
    if (
      message.operation === "submit" ||
      message.operation === "submitAndWait"
    ) {
      saved =
        message.submission ??
        client.executions.prepare(message.capabilityKey, message.request ?? {});
      process.send?.({ type: "prepared", submission: saved });
      const handle = await client.executions.submit(saved);
      process.send?.({ type: "accepted", handle });
      result =
        message.operation === "submit"
          ? { submission: saved, handle }
          : {
              submission: saved,
              handle,
              result: await client.executions.wait(handle, message.waitOptions),
            };
    } else if (message.operation === "wait") {
      result = await client.executions.wait(
        message.handle ?? message.executionId,
        message.waitOptions,
      );
    } else if (message.operation === "get") {
      result = await client.executions.get(message.executionId);
    } else throw new Error("Unknown SDK fixture operation.");
    process.send?.({ type: "result", result, history });
  } catch (error) {
    // No raw transport/provider bodies, request input or credentials enter evidence.
    process.send?.({
      type: "error",
      error: {
        name: error.name,
        message: error.message,
        status: error.status,
        executionId: error.executionId,
        submissionKey: error.submissionKey ?? saved?.submissionKey,
        code: error.body?.code,
      },
      history,
    });
  } finally {
    await client?.shutdown();
    process.disconnect?.();
  }
});
process.send?.({ type: "ready" });
