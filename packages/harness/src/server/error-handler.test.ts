import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unhandledRequestErrorHandler } from "./error-handler.js";

describe("unhandledRequestErrorHandler", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    vi.restoreAllMocks();
  });

  async function throwFrom(err: unknown): Promise<Response> {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    app.get("/boom", () => {
      throw err;
    });
    app.use(unhandledRequestErrorHandler);
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    return fetch(`http://127.0.0.1:${port}/boom`);
  }

  it("returns the real message and errno-style code, not a generic string", async () => {
    // The generic {"error":"internal error"} cost a full diagnostic round-trip
    // on the packaged Windows app, where this body is the only channel the
    // real cause can reach a human through.
    const err = Object.assign(new Error("spawn ENOTDIR: something specific"), { code: "ENOTDIR" });
    const res = await throwFrom(err);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "spawn ENOTDIR: something specific", code: "ENOTDIR" });
  });

  it("omits code when there is none, and falls back for message-less throws", async () => {
    const res = await throwFrom("not-an-error");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });
});
