import { resolveToolsBaseUrl } from "./tools-base.js";

describe("resolveToolsBaseUrl", () => {
  const ORIGINAL = process.env.SAPIOM_TOOLS_BASE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SAPIOM_TOOLS_BASE;
    else process.env.SAPIOM_TOOLS_BASE = ORIGINAL;
  });

  it("falls back to the production tools host", () => {
    delete process.env.SAPIOM_TOOLS_BASE;
    expect(resolveToolsBaseUrl()).toBe("https://tools.sapiom.ai");
  });

  it("trims trailing slashes from SAPIOM_TOOLS_BASE", () => {
    process.env.SAPIOM_TOOLS_BASE = "https://tools.example//";
    expect(resolveToolsBaseUrl()).toBe("https://tools.example");
  });

  it("prefers the first set override and trims it too", () => {
    process.env.SAPIOM_TOOLS_BASE = "https://tools.example";
    expect(
      resolveToolsBaseUrl(undefined, "http://agents.localhost:3100/"),
    ).toBe("http://agents.localhost:3100");
  });
});
