/**
 * Every namespace keeps its own error class through the shared non-2xx path.
 *
 * The `name` column is a contract: the platform recognises a failed Sapiom call
 * by these exact names (SAP-3509), so renaming a class is a breaking change for
 * it, not a refactor.
 */
import { Transport } from "./index.js";
import { TransportHttpError } from "./errors.js";

import { ensureOk as browserAutomation } from "../browser-automation/errors.js";
import { ensureOk as contentGeneration } from "../content-generation/errors.js";
import { ensureOk as database } from "../database/errors.js";
import { ensureOk as domains } from "../domains/errors.js";
import { ensureOk as email } from "../email/errors.js";
import { ensureOk as fileStorage } from "../file-storage/errors.js";
import { ensureOk as keys } from "../keys/errors.js";
import { ensureOk as memory } from "../memory/errors.js";
import { ensureCodingRunOk } from "../models/errors.js";
import { ensureOk as sandboxes } from "../sandboxes/multipart.js";
import { ensureOk as search } from "../search/errors.js";
import { ensureOk as speech } from "../speech/errors.js";
import { ensureOk as vault } from "../vault/errors.js";
import { AgentDispatchError } from "../agents/index.js";

type EnsureOk = (response: Response, errorPrefix: string) => Promise<Response>;

const NAMESPACES: ReadonlyArray<readonly [name: string, ensure: EnsureOk]> = [
  ["BrowserAutomationHttpError", browserAutomation],
  ["ContentGenerationHttpError", contentGeneration],
  ["DatabaseHttpError", database],
  ["DomainsHttpError", domains],
  ["EmailHttpError", email],
  ["FileStorageHttpError", fileStorage],
  ["KeysHttpError", keys],
  ["MemoryHttpError", memory],
  ["CodingRunHttpError", ensureCodingRunOk],
  ["SandboxHttpError", sandboxes],
  ["SearchHttpError", search],
  ["SpeechHttpError", speech],
  ["VaultHttpError", vault],
];

const rejection = (p: Promise<unknown>): Promise<unknown> =>
  p.then(() => null).catch((e: unknown) => e);

describe.each(NAMESPACES)("%s", (name, ensure) => {
  it("returns a 2xx response untouched", async () => {
    const ok = new Response("{}", { status: 200 });

    await expect(ensure(ok, "Failed")).resolves.toBe(ok);
  });

  it.each([503, 429, 404])(
    "throws its own class with status %s",
    async (status) => {
      const err = await rejection(
        ensure(new Response("boom", { status }), "Failed to act"),
      );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe(name);
      expect((err as { status: unknown }).status).toBe(status);
    },
  );
});

describe("message and body shapes are unchanged", () => {
  it.each(
    NAMESPACES.filter(
      ([name]) => name !== "CodingRunHttpError" && name !== "SandboxHttpError",
    ),
  )(
    "%s keeps `<prefix>: <status> <text>` and the parsed body",
    async (_name, ensure) => {
      const err = (await rejection(
        ensure(
          new Response(JSON.stringify({ error: "down" }), { status: 503 }),
          "Failed to act",
        ),
      )) as Error & { body: unknown };

      expect(err.message).toBe(
        `Failed to act: 503 ${JSON.stringify({ error: "down" })}`,
      );
      expect(err.body).toEqual({ error: "down" });
    },
  );

  it("CodingRunHttpError prefers the body's message and omits the trailing space", async () => {
    const withMessage = (await rejection(
      ensureCodingRunOk(
        new Response(
          JSON.stringify({ message: "run not found", error: "run_not_found" }),
          { status: 404 },
        ),
        "Failed to poll",
      ),
    )) as Error & { code: unknown };
    const withoutBody = (await rejection(
      ensureCodingRunOk(new Response("", { status: 500 }), "Failed to poll"),
    )) as Error;

    expect(withMessage.message).toBe("run not found");
    expect(withMessage.code).toBe("run_not_found");
    expect(withoutBody.message).toBe("Failed to poll: 500");
  });

  it("SandboxHttpError keeps its retryAfterMs", async () => {
    const err = (await rejection(
      sandboxes(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
        "Failed to upload part",
      ),
    )) as Error & { retryAfterMs?: number };

    expect(err.message).toBe("Failed to upload part: 429 slow down");
    expect(err.retryAfterMs).toBe(2000);
  });
});

describe("error names outside the namespace wrappers", () => {
  it("Transport.request throws TransportHttpError with its status", async () => {
    const transport = new Transport({
      apiKey: "test-key",
      fetch: (async () =>
        new Response("down", { status: 502 })) as typeof globalThis.fetch,
    });

    const err = await rejection(
      transport.request("https://api.sapiom.ai/v2/sessions"),
    );

    expect(err).toBeInstanceOf(TransportHttpError);
    expect((err as Error).name).toBe("TransportHttpError");
    expect((err as TransportHttpError).status).toBe(502);
  });

  it("AgentDispatchError keeps its name and status", () => {
    const err = new AgentDispatchError({
      code: "platform_error",
      status: 503,
      message: "down",
      details: null,
    } as never);

    expect(err.name).toBe("AgentDispatchError");
    expect(err.status).toBe(503);
  });
});
