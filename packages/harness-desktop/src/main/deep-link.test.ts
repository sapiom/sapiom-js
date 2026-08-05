import { describe, expect, it } from "vitest";

import { deepLinkFromArgv, parseDeepLink } from "./deep-link.js";

describe("parseDeepLink — agent", () => {
  it("parses sapiom://agent/<id>", () => {
    expect(parseDeepLink("sapiom://agent/188")).toEqual({ kind: "agent", definitionId: "188" });
  });

  it("accepts the agents alias and a trailing slash", () => {
    expect(parseDeepLink("sapiom://agents/188/")).toEqual({ kind: "agent", definitionId: "188" });
  });

  it("is case-insensitive in the scheme and host", () => {
    expect(parseDeepLink("SAPIOM://Agent/188")).toEqual({ kind: "agent", definitionId: "188" });
  });

  it("carries optional slug and org hints", () => {
    expect(parseDeepLink("sapiom://agent/188?slug=weather&org=acme")).toEqual({
      kind: "agent",
      definitionId: "188",
      slug: "weather",
      org: "acme",
    });
  });

  it("decodes a percent-encoded id", () => {
    expect(parseDeepLink("sapiom://agent/a%2Fb")).toEqual({ kind: "agent", definitionId: "a/b" });
  });
});

describe("parseDeepLink — template", () => {
  it("parses sapiom://templates/<id>", () => {
    expect(parseDeepLink("sapiom://templates/support-resolution")).toEqual({
      kind: "template",
      templateId: "support-resolution",
    });
  });

  it("accepts the template alias and a trailing slash", () => {
    expect(parseDeepLink("sapiom://template/newsletter-autopilot/")).toEqual({
      kind: "template",
      templateId: "newsletter-autopilot",
    });
  });

  it("carries an optional slug hint and decodes the id", () => {
    expect(parseDeepLink("sapiom://templates/a%2Fb?slug=demo")).toEqual({
      kind: "template",
      templateId: "a/b",
      slug: "demo",
    });
  });
});

describe("parseDeepLink — rejects", () => {
  it("rejects a foreign scheme", () => {
    expect(parseDeepLink("https://app.sapiom.ai/agents/188")).toBeNull();
  });

  it("rejects an unknown host", () => {
    expect(parseDeepLink("sapiom://run/188")).toBeNull();
  });

  it("rejects a missing id", () => {
    expect(parseDeepLink("sapiom://agent/")).toBeNull();
    expect(parseDeepLink("sapiom://agent")).toBeNull();
    expect(parseDeepLink("sapiom://templates/")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseDeepLink("not a url")).toBeNull();
  });
});

describe("deepLinkFromArgv", () => {
  it("finds the sapiom:// token anywhere in argv", () => {
    expect(deepLinkFromArgv(["/path/to/electron", "--flag", "sapiom://agent/7"])).toBe("sapiom://agent/7");
  });

  it("returns null when no deep link is present", () => {
    expect(deepLinkFromArgv(["/path/to/electron", "--dev"])).toBeNull();
  });
});
