/**
 * The update window's design-system wiring is the same cross-file contract the
 * setup window has, and breaks the same silent ways (see setup.html.test.ts): the
 * window still renders, just in the wrong brand, or with a stylesheet the build
 * never copied. So this asserts BOTH halves — what the HTML asks for, and what
 * `scripts/copy-renderer.mjs` puts in dist/renderer.
 *
 * Unlike the setup window, this one's agreed design DOES place the "S" mark beside
 * the wordmark (a lockup setup deliberately avoids), so the brand assertions here
 * pin the mark+wordmark pair — both inlined in currentColor — rather than forbid
 * the mark. Text assertions over a DOM, deliberately: this package's vitest run
 * never imports `electron` (see vitest.config.ts).
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("./update.html", import.meta.url), "utf8");
const copyScript = readFileSync(new URL("../../scripts/copy-renderer.mjs", import.meta.url), "utf8");

/** Every linked stylesheet, in document order — the order IS the contract. */
const stylesheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)" \/>/g)].map((m) => m[1]);

describe("update.html design-system wiring", () => {
  it("scopes the Studio preset on <html>, where data-theme also lives", () => {
    expect(html).toMatch(/<html lang="en" data-product="sapiom-studio">/);
  });

  it("links fonts → tokens → studio → own layout, in that order", () => {
    // The same three design-system files, in the same order, as setup.html and the
    // SPA's styles.css — then this window's OWN layout last (update.css, not
    // setup.css), so it can read every token above it.
    expect(stylesheets).toEqual(["./ds-fonts.css", "./ds-tokens.css", "./themes/studio.css", "./update.css"]);
  });

  it("never LINKS agent-cloud — studio.css @imports it, and a later link would win", () => {
    expect(stylesheets.filter((href) => href.includes("agent-cloud"))).toEqual([]);
  });
});

describe("update.html brand lockup", () => {
  // The wordmark's official path head (identical to setup.html / BrandLogotype.tsx)
  // and the "S" mark's (sapiom-mark.svg). Their opening commands are enough to prove
  // the REAL assets are inlined, not placeholders.
  const LOGOTYPE_PATH_HEAD = "M32.1834 7.36578L34.4714 5.81493";
  const MARK_PATH_HEAD = "M105.267 60.7219L98.8902";

  it("inlines the real Sapiom wordmark, in currentColor", () => {
    expect(html).toContain('class="brand-logotype"');
    expect(html).toContain(LOGOTYPE_PATH_HEAD);
  });

  it("inlines the real 'S' mark beside it, in currentColor (ink, not brand green)", () => {
    // Inlined (not <img>) so a public clone needs no binary and the CSP no img-src;
    // currentColor so .brand-mark themes it to ink, keeping green for state only.
    expect(html).toContain('class="brand-mark"');
    expect(html).toContain(MARK_PATH_HEAD);
    // No hardcoded brand-green fill leaked in from the source asset.
    expect(html).not.toMatch(/fill="#6[bB]/);
    // Every path in the lockup draws in currentColor.
    expect([...html.matchAll(/<path\b[^>]*>/g)].every((m) => m[0].includes('fill="currentColor"'))).toBe(true);
  });

  it("names the app 'Sapiom agent.studio', the same lockup as the SPA header", () => {
    expect(html).toMatch(/aria-label="Sapiom agent\.studio"/);
    expect(html).toMatch(/class="brand-product"[^>]*>agent\.studio</);
  });
});

describe("update.html controls the renderer + updater rely on", () => {
  it("carries the version placeholders, the toggle, and all three actions", () => {
    for (const id of ['id="version-header"', 'id="version-body"', 'id="auto-update"', 'id="skip"', 'id="later"', 'id="restart"']) {
      expect(html, `update.html is missing ${id}`).toContain(id);
    }
  });

  it("loads its module renderer", () => {
    expect(html).toMatch(/<script type="module" src="\.\/update\.js"><\/script>/);
  });
});

describe("copy-renderer.mjs puts every linked file in dist/renderer", () => {
  it("copies something for each stylesheet update.html links", () => {
    for (const href of stylesheets) {
      // "./themes/studio.css" → "themes"; "./update.css" → "update.css".
      const target = href.replace("./", "").split("/")[0];
      expect(copyScript, `${href} is linked but nothing copies "${target}"`).toContain(target);
    }
  });

  it("copies update.html itself alongside setup.html", () => {
    expect(copyScript).toContain("update.html");
  });
});
