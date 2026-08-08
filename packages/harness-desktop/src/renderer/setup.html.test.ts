/**
 * The onboarding window's brand wiring is a contract across TWO files, and every
 * way of breaking it is silent: the window still renders, just in the wrong
 * brand. It shipped in the old Agent Cloud teal for months for exactly that
 * reason, while every other check stayed green.
 *
 *  - `data-product="sapiom-studio"` missing from <html> and every
 *    `[data-product="sapiom-studio"][data-theme="…"]` rule in studio.css misses.
 *    Green, the neutral focus ring and the compact type ladder all vanish. It has
 *    to be on <html>, because that is where the pre-paint script puts
 *    `data-theme` and studio's brand rules are COMPOUND selectors on one element.
 *  - a stray <link> to agent-cloud.css AFTER studio.css restores the teal
 *    outright. studio.css @imports agent-cloud itself and their selectors carry
 *    equal specificity, so the winner is decided by source order alone.
 *  - a link whose file the build never copies just 404s. A <link> that fails and
 *    a stylesheet that loaded but defined nothing are indistinguishable from the
 *    page, so this file asserts BOTH halves — what the HTML asks for, and what
 *    `scripts/copy-renderer.mjs` puts in dist/renderer.
 *
 * Text assertions over a DOM, deliberately: this package's vitest run never
 * imports `electron` (see vitest.config.ts). The packaged `preload-bridge` smoke
 * check (src/main/smoke.ts) is the other half — it reads COMPUTED token values in
 * the real window, the only place "the cascade actually produced Studio" can be
 * observed.
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("./setup.html", import.meta.url), "utf8");
const copyScript = readFileSync(new URL("../../scripts/copy-renderer.mjs", import.meta.url), "utf8");

/** Every linked stylesheet, in document order — the order IS the contract. */
const stylesheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)" \/>/g)].map((m) => m[1]);

describe("setup.html design-system wiring", () => {
  it("scopes the Studio preset on <html>, where data-theme also lives", () => {
    expect(html).toMatch(/<html lang="en" data-product="sapiom-studio">/);
  });

  it("links fonts → tokens → studio → own layout, in that order", () => {
    // The same three design-system files, in the same order, as the SPA's
    // styles.css imports them. fonts.css must precede tokens.css (its own header
    // says so), and setup.css must come last so it can read every token above it.
    expect(stylesheets).toEqual([
      "./ds-fonts.css",
      "./ds-tokens.css",
      "./themes/studio.css",
      "./setup.css",
    ]);
  });

  it("never LINKS agent-cloud — studio.css @imports it, and a later link would win", () => {
    // Matched against the links, not the whole file: setup.html's comment names
    // agent-cloud on purpose, to explain why it must not be linked separately.
    expect(stylesheets.filter((href) => href.includes("agent-cloud"))).toEqual([]);
  });
});

describe("setup.html brand lockup", () => {
  // The wordmark's official path (design-system/assets/sapiom-logotype.svg,
  // identical to the SPA's BrandLogotype.tsx). Its opening command is enough to
  // prove the REAL asset is inlined, not a placeholder or a redrawn glyph.
  const LOGOTYPE_PATH_HEAD = "M32.1834 7.36578L34.4714 5.81493";

  it("inlines the real Sapiom wordmark, in currentColor", () => {
    // Inlined (not <img>) so a public clone needs no binary and the CSP needs no
    // img-src; currentColor so .brand-logotype can theme it to ink.
    expect(html).toContain('class="brand-logotype"');
    expect(html).toContain(LOGOTYPE_PATH_HEAD);
    expect(html).toMatch(/<path\b[^>]*\bfill="currentColor"/);
  });

  it("names the app 'Sapiom agent.studio', the same lockup as the SPA header", () => {
    // One accessible name on the lockup (the wordmark itself is aria-hidden), and
    // the product name visible in text beside the mark.
    expect(html).toMatch(/aria-label="Sapiom agent\.studio"/);
    expect(html).toMatch(/class="brand-product"[^>]*>agent\.studio</);
  });

  it("drops the old plain-text wordmark — the logo replaces it", () => {
    // The window shipped a text `<div class="brand">Sapiom</div>` before; the
    // real logo supersedes it, so the placeholder must be gone.
    expect(html).not.toMatch(/<div class="brand">/);
  });
});

describe("copy-renderer.mjs puts every linked file in dist/renderer", () => {
  it("copies something for each stylesheet setup.html links", () => {
    for (const href of stylesheets) {
      // "./themes/studio.css" → "themes"; "./ds-tokens.css" → "ds-tokens.css".
      // Derived from the HTML so this keeps working when a fifth link is added.
      const target = href.replace("./", "").split("/")[0];
      expect(copyScript, `${href} is linked but nothing copies "${target}"`).toContain(target);
    }
  });

  it("copies the font layer, including the woff2 at the path ds-fonts.css asks for", () => {
    expect(copyScript).toMatch(/"fonts\.css"[\s\S]{0,60}"ds-fonts\.css"/);
    expect(copyScript).toMatch(/"assets",\s*"fonts"/);
  });

  it("copies themes/ as a directory instead of flattening it", () => {
    // studio.css's first rule is `@import "./agent-cloud.css"` — a sibling lookup
    // that a flattened copy breaks in total silence. Bounded window so this
    // cannot accidentally match a `recursive` far away in the file.
    expect(copyScript).toMatch(/"themes"[\s\S]{0,120}recursive: true/);
    expect(copyScript).not.toContain("ds-agent-cloud");
  });

  it("the committed fallback really ships what the copy treats as optional", () => {
    // The font copy tolerates absence so an official build against the private
    // package cannot hard-fail on a file we cannot inspect from here. That
    // tolerance must never quietly cover THIS repo's seam — the one every build
    // actually resolves (see web/vite.config.ts's TODO).
    const dsNeutral = new URL("../../../harness/web/src/styles/ds-neutral/", import.meta.url);
    for (const file of [
      "tokens.css",
      "fonts.css",
      "themes/studio.css",
      "themes/agent-cloud.css",
      "assets/fonts/Geist-Variable.woff2",
      "assets/fonts/GeistMono-Variable.woff2",
    ]) {
      expect(existsSync(new URL(file, dsNeutral)), `ds-neutral is missing ${file}`).toBe(true);
    }
  });
});
