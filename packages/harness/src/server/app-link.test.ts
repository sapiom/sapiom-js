/**
 * The App Link router (SAP-3255).
 *
 * What these guard: the definition id coming from the agent's own
 * `sapiom.json` rather than the caller, and every "nothing to show" case
 * answering `{ url: null, status: null }` so the bar renders as it did before.
 */

import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { createAppLinkRouter } from "./app-link.js";
import type { DefinitionAppLinkReader } from "../core/definition-app-link.js";

const LINKED = "/agents/content-pack";
const UNLINKED = "/agents/draft";
const BROKEN = "/agents/broken-config";
const LIVE = "https://apps.sapiom.ai/acme/content-pack";

let servers: { close: () => void }[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});

function startApp(reader: DefinitionAppLinkReader): string {
  const app = express();
  app.use(
    createAppLinkRouter({
      apiKey: "sk_test",
      reader,
      resolveWorkflow: (id) =>
        [LINKED, UNLINKED, BROKEN].includes(id) ? { path: id } : null,
      readConfig: ((dir: string) => {
        if (dir === BROKEN) throw new Error("Unexpected token in sapiom.json");
        return dir === LINKED ? { definitionId: 886 } : {};
      }) as never,
    }),
  );
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function recordingReader(): {
  reader: DefinitionAppLinkReader;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    reader: {
      async read(definitionId) {
        calls.push(definitionId);
        return { url: LIVE, status: "live" };
      },
    },
  };
}

const url = (base: string, id: string): string =>
  `${base}/api/workflows/${encodeURIComponent(id)}/app-link`;

describe("GET /api/workflows/:id/app-link", () => {
  it("reads the link for the definition in the agent's sapiom.json", async () => {
    const { reader, calls } = recordingReader();
    const base = startApp(reader);

    const response = await fetch(url(base, LINKED));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: LIVE,
      status: "live",
    });
    expect(calls).toEqual(["886"]);
  });

  it("answers no App Link for an unlinked agent without calling core", async () => {
    const { reader, calls } = recordingReader();
    const base = startApp(reader);

    const response = await fetch(url(base, UNLINKED));

    await expect(response.json()).resolves.toEqual({ url: null, status: null });
    expect(calls).toEqual([]);
  });

  it("answers no App Link when sapiom.json cannot be read", async () => {
    const { reader, calls } = recordingReader();
    const base = startApp(reader);

    const response = await fetch(url(base, BROKEN));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: null, status: null });
    expect(calls).toEqual([]);
  });

  it("404s an id that names no registered agent", async () => {
    const { reader, calls } = recordingReader();
    const base = startApp(reader);

    const response = await fetch(url(base, "/agents/unknown"));

    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
