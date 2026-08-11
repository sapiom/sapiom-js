/**
 * The setup window sets a pre-paint `backgroundColor` (windows.ts) so it doesn't
 * flash before its stylesheet loads. That colour is a HARDCODED hex in the main
 * process — main can't read CSS — so it can silently drift from the token the
 * renderer actually paints, which is exactly the class of silent brand drift this
 * package guards elsewhere (see renderer/setup.html.test.ts).
 *
 * The window itself is the card now (setup.css `body` paints the raised surface
 * --s1 edge to edge), so the pre-paint colour must be --s1, not --bg. Studio's
 * preset (themes/studio.css) does NOT override --s1, so both themes take it
 * straight from tokens.css: dark from the `:root`/`[data-theme="dark"]` block,
 * light from the `[data-theme="light"]` block. Resolved against the ds-neutral
 * fallback — the seam every build in THIS public repo actually copies in
 * (web/vite.config.ts / copy-renderer.mjs). Asserted as TEXT (no electron
 * import; see vitest.config.ts).
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const windowsSrc = readFileSync(new URL("./windows.ts", import.meta.url), "utf8");
const updateWindowSrc = readFileSync(new URL("./update-window.ts", import.meta.url), "utf8");
const dsNeutral = new URL("../../../harness/web/src/styles/ds-neutral/", import.meta.url);
const tokensCss = readFileSync(new URL("tokens.css", dsNeutral), "utf8");

// The condition differs per window (setup uses nativeTheme directly; the update
// window resolves the app's theme first), so match any `backgroundColor: <cond> ?
// "#dark" : "#light"` and pin the two hexes to the --s1 token below.
const BG_TERNARY = /backgroundColor:[^?\n]*\?\s*"(#[0-9a-fA-F]{3,8})"\s*:\s*"(#[0-9a-fA-F]{3,8})"/;

/** Each window's backgroundColor ternary → [darkHex, lightHex]. */
const bg = windowsSrc.match(BG_TERNARY);
const updateBg = updateWindowSrc.match(BG_TERNARY);

/** Every `--s1:` hex in document order — tokens.css has [0]=dark block, [1]=light block. */
const s1 = [...tokensCss.matchAll(/--s1:\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => m[1].toLowerCase());
/** Every `--bg:` hex in document order — the update window fills with --bg (the app's
 *  base background), not the raised --s1 the setup window uses. */
const bgToken = [...tokensCss.matchAll(/--bg:\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => m[1].toLowerCase());

describe("setup window backgroundColor matches the Studio --s1 surface token", () => {
  it("sets a themed pre-paint background at all (no flash)", () => {
    expect(bg, "windows.ts should set backgroundColor from nativeTheme").not.toBeNull();
  });

  it("tokens.css declares --s1 for both themes", () => {
    expect(s1.length).toBeGreaterThanOrEqual(2);
  });

  it("dark background == tokens.css dark --s1", () => {
    expect(bg![1].toLowerCase()).toBe(s1[0]);
  });

  it("light background == tokens.css light --s1", () => {
    // studio.css overrides --bg but NOT --s1, so light --s1 is tokens.css's own
    // light-block value — the surface the renderer paints edge to edge.
    expect(bg![2].toLowerCase()).toBe(s1[1]);
  });
});

describe("update window backgroundColor matches the app's --bg base surface token", () => {
  // The update window fills with --bg (the app's base background) so it reads as the
  // same black as the app — see update.css — not the raised --s1 the setup window uses.
  it("sets a themed pre-paint background at all (no flash)", () => {
    expect(updateBg, "update-window.ts should set backgroundColor from the resolved theme").not.toBeNull();
  });

  it("tokens.css declares --bg for both themes", () => {
    expect(bgToken.length).toBeGreaterThanOrEqual(2);
  });

  it("dark background == tokens.css dark --bg", () => {
    expect(updateBg![1].toLowerCase()).toBe(bgToken[0]);
  });

  it("light background == tokens.css light --bg", () => {
    expect(updateBg![2].toLowerCase()).toBe(bgToken[1]);
  });
});
