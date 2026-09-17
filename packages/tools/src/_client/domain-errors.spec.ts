/**
 * One table over every capability namespace's non-2xx path. It is the guard on
 * the sweep: each namespace still throws its OWN public error class (so an
 * author's `instanceof` check is untouched) and every one of them now records
 * the same facts, deterministic statuses included.
 */
import { readSapiomCall } from "./sapiom-call.js";

import { ensureOk as browserAutomation } from "../browser-automation/errors.js";
import { BrowserAutomationHttpError } from "../browser-automation/errors.js";
import { ensureOk as contentGeneration } from "../content-generation/errors.js";
import { ContentGenerationHttpError } from "../content-generation/errors.js";
import { ensureOk as database } from "../database/errors.js";
import { DatabaseHttpError } from "../database/errors.js";
import { ensureOk as domains } from "../domains/errors.js";
import { DomainsHttpError } from "../domains/errors.js";
import { ensureOk as email } from "../email/errors.js";
import { EmailHttpError } from "../email/errors.js";
import { ensureOk as fileStorage } from "../file-storage/errors.js";
import { FileStorageHttpError } from "../file-storage/errors.js";
import { ensureOk as keys } from "../keys/errors.js";
import { KeysHttpError } from "../keys/errors.js";
import { ensureOk as memory } from "../memory/errors.js";
import { MemoryHttpError } from "../memory/errors.js";
import { ensureCodingRunOk } from "../models/errors.js";
import { CodingRunHttpError } from "../models/errors.js";
import { ensureOk as sandboxes } from "../sandboxes/multipart.js";
import { SandboxHttpError } from "../sandboxes/multipart.js";
import { ensureOk as search } from "../search/errors.js";
import { SearchHttpError } from "../search/errors.js";
import { ensureOk as speech } from "../speech/errors.js";
import { SpeechHttpError } from "../speech/errors.js";
import { ensureOk as vault } from "../vault/errors.js";
import { VaultHttpError } from "../vault/errors.js";

type EnsureOk = (response: Response, errorPrefix: string) => Promise<Response>;

const NAMESPACES: ReadonlyArray<
  readonly [name: string, ensure: EnsureOk, klass: new (...a: never[]) => Error]
> = [
  ["browserAutomation", browserAutomation, BrowserAutomationHttpError],
  ["contentGeneration", contentGeneration, ContentGenerationHttpError],
  ["database", database, DatabaseHttpError],
  ["domains", domains, DomainsHttpError],
  ["email", email, EmailHttpError],
  ["fileStorage", fileStorage, FileStorageHttpError],
  ["keys", keys, KeysHttpError],
  ["memory", memory, MemoryHttpError],
  ["models", ensureCodingRunOk, CodingRunHttpError],
  ["sandboxes", sandboxes, SandboxHttpError],
  ["search", search, SearchHttpError],
  ["speech", speech, SpeechHttpError],
  ["vault", vault, VaultHttpError],
];

const rejection = (p: Promise<unknown>): Promise<unknown> =>
  p.then(() => null).catch((e: unknown) => e);

describe.each(NAMESPACES)("%s ensureOk()", (name, ensure, klass) => {
  it("returns a 2xx response untouched", async () => {
    const ok = new Response("{}", { status: 200 });

    await expect(ensure(ok, "Failed")).resolves.toBe(ok);
  });

  it.each([503, 429, 408, 500])(
    "throws its own class with the facts on a %s",
    async (status) => {
      const err = await rejection(
        ensure(new Response("boom", { status }), "Failed to act"),
      );

      expect(err).toBeInstanceOf(klass);
      expect(readSapiomCall(err)).toEqual({
        version: 1,
        capability: name,
        status,
      });
    },
  );

  it("records a deterministic 404 too: the facts carry no verdict", async () => {
    const err = await rejection(
      ensure(new Response("nope", { status: 404 }), "Failed to act"),
    );

    expect(err).toBeInstanceOf(klass);
    expect(readSapiomCall(err)).toEqual({
      version: 1,
      capability: name,
      status: 404,
    });
  });

  it("records Retry-After when the service sends one", async () => {
    const err = await rejection(
      ensure(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "5" },
        }),
        "Failed to act",
      ),
    );

    expect(readSapiomCall(err)?.retryAfterMs).toBe(5000);
  });
});

describe("message and body shapes are unchanged by the sweep", () => {
  it.each(
    NAMESPACES.filter(([name]) => name !== "models" && name !== "sandboxes"),
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

  it("models prefers the body's own message and omits the trailing space", async () => {
    const withMessage = (await rejection(
      ensureCodingRunOk(
        new Response(
          JSON.stringify({ message: "run not found", error: "run_not_found" }),
          {
            status: 404,
          },
        ),
        "Failed to poll",
      ),
    )) as CodingRunHttpError;
    const withoutBody = (await rejection(
      ensureCodingRunOk(new Response("", { status: 500 }), "Failed to poll"),
    )) as CodingRunHttpError;

    expect(withMessage.message).toBe("run not found");
    expect(withMessage.code).toBe("run_not_found");
    expect(withoutBody.message).toBe("Failed to poll: 500");
  });

  it("sandboxes keeps carrying retryAfterMs on its own error class", async () => {
    const err = (await rejection(
      sandboxes(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
        "Failed to upload part",
      ),
    )) as SandboxHttpError;

    expect(err).toBeInstanceOf(SandboxHttpError);
    expect(err.message).toBe("Failed to upload part: 429 slow down");
    expect(err.retryAfterMs).toBe(2000);
  });
});
