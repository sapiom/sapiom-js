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
    expect(load).toMatch(/if \(seq !== slaSeq\) return;\s*showSlaState\(sla\);/);
    expect(page).toContain('slaWrite(() => post("/api/sla", body, "PUT"), "SLA saved")');
    expect(page).toContain('() => post("/api/sla", undefined, "DELETE")');
  });

  it("names the digest's age table apart from the SLA, and says the SLA drives the digest", () => {
    expect(page).toContain(
      "Digest age threshold (hours), used only while SLA is unset",
    );
    expect(page).not.toContain("Digest flags open tickets older than");
    const sla = page.slice(
      page.indexOf('<section class="card" id="sla">'),
      page.indexOf('id="sla-json"'),
    );
    expect(sla).toContain("the daily digest flags issues whose target is");
  });
});
