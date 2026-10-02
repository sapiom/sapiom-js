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
      capabilityDelivery: message.capabilityDelivery ?? "legacy",
      fetch: async (url, init) => {
        loopback(new URL(String(url)).origin);
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
    } else if (message.operation === "capability") {
      const methods = {
        "web.search": client.search.webSearch,
        "web.scrape": client.search.scrape,
        "email.find": client.search.emailSearch.findEmail,
        "email.verify": client.search.emailSearch.verifyEmail,
        "email.domain.search": client.search.emailSearch.domainSearch,
        "content.generation.images":
          message.verb === "launch"
            ? client.contentGeneration.images.launch
            : client.contentGeneration.images.create,
        "content.generation.video":
          message.verb === "launch"
            ? client.contentGeneration.video.launch
            : client.contentGeneration.video.create,
        "memory.append": client.memory.append,
        "memory.recall": client.memory.recall,
        "memory.forget": client.memory.forget,
        "memory.drop": (input) => client.memory.drop(input.namespace),
        "database.create": client.database.create,
        "domains.purchase": client.domains.register,
        "storage.put": client.fileStorage.upload,
      };
      if (!Object.hasOwn(methods, message.capabilityKey))
        throw new Error("Unsupported adoption fixture capability");
      result = await methods[message.capabilityKey](message.request ?? {});
      if (message.waitForNative) {
        if (typeof result?.wait !== "function")
          throw new Error("Native handle lost its wait method");
        result = await result.wait();
      }
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
