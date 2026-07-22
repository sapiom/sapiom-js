import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { createStaticRouter } from "./static.js";

// ---------------------------------------------------------------------------
// The static router is the SPA-serving seam: `pnpm build` emits the Studio to
// dist/web (web/vite.config.ts `outDir`), and the harness server mounts this
// router pointed at that directory as the catch-all. These tests pin that
// contract — a built bundle is served (index.html, hashed assets, and the SPA
// deep-route fallback), and an unbuilt tree degrades to the placeholder rather
// than 404ing — so the launch-critical `build → serve → npx` path can't
// silently regress.
// ---------------------------------------------------------------------------

describe("createStaticRouter", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;
  const tmpDirs: string[] = [];

  function start(webDir: string): void {
    const app = express();
    app.use(createStaticRouter(webDir));
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  /** A fixture that mimics a real `vite build` output tree under dist/web. */
  function makeBuiltWebDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "harness-web-"));
    tmpDirs.push(dir);
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(
      join(dir, "index.html"),
      '<!doctype html><html><head><title>Sapiom Studio</title>' +
        '<script type="module" src="/assets/index-abc123.js"></script>' +
        '</head><body><div id="root"></div></body></html>',
    );
    writeFileSync(
      join(dir, "assets", "index-abc123.js"),
      'console.log("studio bundle");',
    );
    return dir;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("when the web bundle is built (dist/web present)", () => {
    it("serves index.html (the built SPA, not the placeholder) at the root", async () => {
      start(makeBuiltWebDir());

      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<title>Sapiom Studio</title>");
      expect(html).toContain('<div id="root">');
      expect(html).not.toContain("hasn't been built yet");
    });

    it("serves hashed static assets with the correct content type", async () => {
      start(makeBuiltWebDir());

      const res = await fetch(`${baseUrl}/assets/index-abc123.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(await res.text()).toContain("studio bundle");
    });

    it("falls back to index.html for unknown deep routes (client-side SPA routing)", async () => {
      start(makeBuiltWebDir());

      const res = await fetch(`${baseUrl}/some/client/route`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<title>Sapiom Studio</title>");
    });
  });

  describe("when the web bundle has not been built (dist/web absent)", () => {
    it("serves a placeholder page instead of 404ing, so API/WS testing still works", async () => {
      const missing = join(tmpdir(), `harness-web-missing-${Date.now()}`);
      start(missing);

      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Sapiom Harness");
      expect(html).toContain("hasn't been built yet");
    });
  });
});
