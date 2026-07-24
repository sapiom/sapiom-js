import { describe, expect, it } from "vitest";
import { slugify, todayIso } from "./util.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Polsia")).toBe("polsia");
    expect(slugify("Acme Corp, Inc.")).toBe("acme-corp-inc");
  });
  it("strips accents and trims hyphens", () => {
    expect(slugify("Café Été!")).toBe("cafe-ete");
  });
  it("caps length at 40 and never returns empty", () => {
    expect(slugify("x".repeat(80)).length).toBe(40);
    expect(slugify("!!!")).toBe("company");
  });
});

describe("todayIso", () => {
  it("returns YYYY-MM-DD", () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
