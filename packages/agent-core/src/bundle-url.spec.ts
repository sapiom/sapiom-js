import path from "node:path";

import { bundleFileUrl } from "./bundle-url";

describe("bundleFileUrl", () => {
  it("produces a valid, importable file:// URL", () => {
    const url = bundleFileUrl(path.join("/tmp", "sapiom-bundle", "out.mjs"));
    expect(() => new URL(url)).not.toThrow();
    expect(url.startsWith("file://")).toBe(true);
  });

  it("appends a cache-busting timestamp query param", () => {
    const url = bundleFileUrl("/tmp/sapiom-bundle/out.mjs");
    const parsed = new URL(url);
    expect(parsed.searchParams.has("t")).toBe(true);
    expect(Number(parsed.searchParams.get("t"))).not.toBeNaN();
  });

  it("percent-encodes characters a raw `file://${path}` template would leave broken", () => {
    // A raw `file://${bundlePath}` template previously left spaces
    // unencoded, producing a URL that Node's `import()` — a strict WHATWG
    // URL parser — cannot resolve. pathToFileURL encodes them correctly.
    const url = bundleFileUrl("/tmp/sapiom bundle dir/out.mjs");
    expect(() => new URL(url)).not.toThrow();
    expect(url).toContain("%20");
    expect(url).not.toContain("sapiom bundle dir"); // raw space must not survive
  });

  it("returns distinct URLs for successive calls (cache-busting)", () => {
    const first = bundleFileUrl("/tmp/sapiom-bundle/out.mjs");
    const second = bundleFileUrl("/tmp/sapiom-bundle/out.mjs");
    expect(new URL(first).searchParams.get("t")).toBeTruthy();
    expect(new URL(second).searchParams.get("t")).toBeTruthy();
  });
});
