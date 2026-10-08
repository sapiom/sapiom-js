/** The Console page's SLA wiring, read from `index.html` (the page has no build step to test). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const page = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "index.html"),
  "utf8",
);

describe("console page SLA", () => {
  it("prints each board row's slaLabel under an SLA header", () => {
    expect(page).toContain("<th>Priority</th><th>SLA</th>");
    expect(page).toContain("${i.slaLabel ? esc(i.slaLabel) : none}");
  });

  it("has the SLA editor in the Settings tab, wired to the three routes", () => {
    const settings = page.slice(
      page.indexOf('<section id="view-settings"'),
      page.indexOf("<!-- System -->"),
    );
    for (const id of ["sla", "sla-json", "sla-save", "sla-clear", "sla-error"])
      expect(settings).toContain(`id="${id}"`);
    expect(page).toContain('get("/api/sla")');
    // Loaded apart from the desk settings, and never over unsaved edits.
    expect(page).toContain('if (name === "settings") loadSla();');
    expect(page).toContain("if (slaDirty && !force) return;");
    // Keep validation errors beside the editor so the operator can correct the submitted settings.
    expect(page).toMatch(
      /showSlaState\(\(await request\(\)\)\.sla\);\s*\} catch \(e\) \{\s*\$\("sla-error"\)\.textContent = e\.message;/,
    );
  });

  it("allows one SLA write at a time and keeps text typed during a save", () => {
    const write = page.slice(
      page.indexOf("async function slaWrite("),
      page.indexOf('$("sla-save").onclick'),
    );
    // Both buttons stay disabled until the request and its reload finish.
    expect(write).toMatch(
      /for \(const b of buttons\) b\.dataset\.busy = "1";\s*syncButtons\(\);/,
    );
    expect(write).toMatch(
      /\} finally \{\s*for \(const b of buttons\) b\.dataset\.busy = "0";\s*syncButtons\(\);/,
    );
    expect(page).toContain('const buttons = [$("sla-save"), $("sla-clear")];');
    // The reload after a write is skipped when the operator typed meanwhile.
    expect(page).toContain("slaRev++;");
    expect(write).toContain("const rev = slaRev;");
    expect(write).toContain("if (slaRev === rev) await loadSla(true);");
    // ...and the reload itself drops its response if the operator types during its GET.
    const load = page.slice(
      page.indexOf("async function loadSla("),
      page.indexOf("async function slaWrite("),
    );
    expect(load).toMatch(/const seq = \+\+slaSeq;\s*const rev = slaRev;/);
    expect(load).toMatch(
      /await get\("\/api\/sla"\);[\s\S]*?if \(slaRev !== rev \|\| \(slaDirty && !force\)\) return;/,
    );
    // The status label follows each write's result, even when the reload is skipped.
    expect(write).toContain("showSlaState((await request()).sla);");
    expect(load).toMatch(
      /if \(seq !== slaSeq\) return;\s*showSlaState\(sla\);/,
    );
    expect(page).toContain(
      'slaWrite(() => post("/api/sla", body, "PUT"), "SLA saved")',
    );
    expect(page).toContain('() => post("/api/sla", undefined, "DELETE")');
  });
});

describe("console page session expiry", () => {
  // The request helpers and the toast, cut from the page and run against a stubbed fetch.
  const code = page.slice(
    page.indexOf("let toastTimer;"),
    page.indexOf("function summarize("),
  );
  function load(fetch: (path: string) => Promise<Response>) {
    const toast = { textContent: "", className: "", hidden: true };
    const calls: string[] = [];
    const api = new Function(
      "$",
      "fetch",
      "location",
      `${code}; return { get, post, log };`,
    )(
      () => toast,
      (path: string) => {
        calls.push(path);
        return fetch(path);
      },
      { search: "", hash: "" },
    ) as {
      get: (p: string) => Promise<unknown>;
      post: (p: string, b?: unknown) => Promise<unknown>;
      log: (line: string) => void;
    };
    return { api, toast, calls };
  }
  const json = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("stops calling and keeps one message up after a 401", async () => {
    const { api, toast, calls } = load(() => json(401, {}));
    await expect(api.post("/api/tickets/1/actions/close")).rejects.toThrow(
      "session expired",
    );
    expect(toast.textContent).toMatch(/^Session expired FAILED: .*Reopen/);
    api.log("close #1: sent");
    expect(toast.textContent).toMatch(/^Session expired/);
    await expect(api.get("/api/board")).rejects.toThrow("session expired");
    expect(calls).toEqual(["/api/tickets/1/actions/close"]);
  });

  it("keeps polling after a request with no answer, so a dropped connection recovers", async () => {
    let down = true;
    const { api, toast, calls } = load(() =>
      down
        ? Promise.reject(new TypeError("Failed to fetch"))
        : json(200, { ok: true }),
    );
    await expect(api.get("/api/board")).rejects.toThrow("Failed to fetch");
    expect(toast.textContent).toMatch(/^Unreachable FAILED: .*retrying/);
    down = false;
    await expect(api.get("/api/board")).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["/api/board", "/api/board"]);
    expect(toast.hidden).toBe(true);
  });

  it("leaves the server's own 403 an ordinary failure", async () => {
    const { api, toast, calls } = load(() =>
      json(403, { error: "'x' is not a fleet agent" }),
    );
    await expect(api.post("/api/fleet/x")).rejects.toThrow("not a fleet agent");
    await expect(api.get("/api/board")).rejects.toThrow("not a fleet agent");
    expect(calls).toHaveLength(2);
    expect(toast.textContent).toBe("");
  });
});
