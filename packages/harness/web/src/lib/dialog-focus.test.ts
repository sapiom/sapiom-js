import { describe, expect, it } from "vitest";

import { initialFocusIndex, wrapFocusIndex } from "./dialog-focus";

/**
 * The trap's rule, tested where it is a rule rather than a DOM.
 *
 * The real Tab/Escape/outside-click behavior is asserted against a browser in
 * web/e2e/dialog-shell.spec.ts — this tier only owns the arithmetic, and owns
 * it because the two failure modes it protects against are silent: a trap that
 * wraps in the INTERIOR of the list (focus order stops matching what a screen
 * reader announces) and a trap that lands on the close button (a dialog that
 * opens half-cancelled, where Enter dismisses it).
 */
describe("wrapFocusIndex", () => {
  it("leaves the interior of the list to the browser", () => {
    // Wrapping here would be re-implementing tab order, which is how a trap
    // starts disagreeing with the sequence assistive tech reads out.
    expect(wrapFocusIndex(4, 1, false)).toBeNull();
    expect(wrapFocusIndex(4, 2, false)).toBeNull();
    expect(wrapFocusIndex(4, 1, true)).toBeNull();
    expect(wrapFocusIndex(4, 3, true)).toBeNull();
  });

  it("wraps forwards off the last control and backwards off the first", () => {
    expect(wrapFocusIndex(4, 3, false)).toBe(0);
    expect(wrapFocusIndex(4, 0, true)).toBe(3);
  });

  it("pulls escaped focus back to the end the user was heading for", () => {
    expect(wrapFocusIndex(4, -1, false)).toBe(0);
    expect(wrapFocusIndex(4, -1, true)).toBe(3);
  });

  it("does nothing when the dialog has no focusable control", () => {
    // The surface's own tabIndex={-1} is the answer in that case, not a wrap
    // onto an index that does not exist.
    expect(wrapFocusIndex(0, -1, false)).toBeNull();
    expect(wrapFocusIndex(0, -1, true)).toBeNull();
  });

  it("wraps a single control onto itself rather than releasing focus", () => {
    expect(wrapFocusIndex(1, 0, false)).toBe(0);
    expect(wrapFocusIndex(1, 0, true)).toBe(0);
  });
});

describe("initialFocusIndex", () => {
  it("skips the header, so a dialog never opens focused on its own close button", () => {
    // headerCount === 1 is the ordinary shape: the × is the first focusable in
    // the DOM, and the first body control is the one the user came for.
    expect(initialFocusIndex(5, 1)).toBe(1);
  });

  it("falls back to the header when the dialog has nothing else", () => {
    expect(initialFocusIndex(1, 1)).toBe(0);
  });

  it("reports that there is nothing to focus, rather than index 0", () => {
    // -1 is not "the first one": the caller focuses the surface instead, and
    // returning 0 here would silently focus whatever happened to be first.
    expect(initialFocusIndex(0, 0)).toBe(-1);
  });

  it("does not skip a header that holds no focusable control", () => {
    expect(initialFocusIndex(3, 0)).toBe(0);
  });
});
