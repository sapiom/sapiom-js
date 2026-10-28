/**
 * Only the harness origin may keep the main window's preload; other local origins go to the
 * preview window. Which external schemes may reach the OS is windows.ts's call.
 */
import { describe, expect, it } from "vitest";
import { classifyNavigation, isLocalUrl } from "./navigation-policy.js";

const HARNESS = "http://127.0.0.1:5400";

describe("classifyNavigation", () => {
  it.each([`${HARNESS}/`, `${HARNESS}/?uiToken=t&agent=a`, `${HARNESS}/canvas/s1/index.html`])(
    "keeps %s on the harness",
    (url) => {
      expect(classifyNavigation(url, HARNESS)).toBe("harness");
    },
  );

  it.each(["http://127.0.0.1:3000/", "http://localhost:5400/", "https://127.0.0.1:5400/", "http://localhost:8080/app"])(
    "sends %s to the preview window",
    (url) => {
      expect(classifyNavigation(url, HARNESS)).toBe("local");
    },
  );

  it.each(["https://example.com/", "file:///etc/passwd", "mailto:a@b.c", "vscode://file/x", "about:blank", "not a url"])(
    "sends %s outside the app",
    (url) => {
      expect(classifyNavigation(url, HARNESS)).toBe("external");
    },
  );
});

describe("isLocalUrl", () => {
  it("accepts http(s) on 127.0.0.1 and localhost, any port", () => {
    expect(isLocalUrl("http://127.0.0.1:1/")).toBe(true);
    expect(isLocalUrl("https://localhost/")).toBe(true);
  });

  it("refuses other hosts, schemes and garbage", () => {
    expect(isLocalUrl("http://127.0.0.2/")).toBe(false);
    expect(isLocalUrl("file:///tmp")).toBe(false);
    expect(isLocalUrl("nope")).toBe(false);
  });
});
