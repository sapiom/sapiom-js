import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVER_JS } from "./html.js";

const PORT = 4712;
let child: ChildProcess;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "roundup-server-"));
  await writeFile(join(dir, "server.js"), SERVER_JS);
  await writeFile(join(dir, "index.html"), "<h1>idx</h1>");
  child = spawn(process.execPath, [join(dir, "server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  // wait for the server to accept connections
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server never came up");
}, 15000);

afterAll(() => {
  child?.kill();
});

describe("SERVER_JS", () => {
  it("serves index.html at / with html content type", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("idx");
  });
  it("404s missing files", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/nope.html`);
    expect(res.status).toBe(404);
  });
  it("refuses path traversal", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/%2e%2e/%2e%2e/etc/passwd`);
    expect([403, 404]).toContain(res.status);
  });
});
