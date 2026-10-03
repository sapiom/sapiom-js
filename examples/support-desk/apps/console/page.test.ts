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
    expect(page).toContain('post("/api/sla", body, "PUT")');
    expect(page).toContain('post("/api/sla", undefined, "DELETE")');
    // Keep validation errors beside the editor so the operator can correct the submitted settings.
    expect(page).toMatch(
      /post\("\/api\/sla", body, "PUT"\);\s*\} catch \(e\) \{\s*\$\("sla-error"\)\.textContent = e\.message;/,
    );
  });
});
