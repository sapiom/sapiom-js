import { describe, expect, it } from "vitest";
import { buildSelectionPrompt, readSelection } from "./select.js";

const articles = [
  { title: "Polsia raises funds", url: "https://a.example/1", snippet: "Polsia announced..." },
  { title: "Unrelated Polsia GmbH", url: "https://b.example/2", snippet: "A German bakery..." },
];

describe("buildSelectionPrompt", () => {
  it("mentions company, date, and every article", () => {
    const p = buildSelectionPrompt("Polsia", "2026-07-22", articles);
    expect(p).toContain("Polsia");
    expect(p).toContain("2026-07-22");
    expect(p).toContain("https://a.example/1");
    expect(p).toContain("https://b.example/2");
    expect(p).toContain("imagePrompt");
  });

  it("no longer asks for a bare JSON array — the tool schema carries the shape", () => {
    const p = buildSelectionPrompt("Polsia", "2026-07-22", articles);
    expect(p).not.toMatch(/ONLY a JSON array/i);
  });
});

describe("readSelection", () => {
  const article = {
    title: "T",
    url: "https://a.example/1",
    summary: "S.",
    imagePrompt: "P",
  };

  it("reads the tool call's articles", () => {
    expect(readSelection({ articles: [article] })).toHaveLength(1);
  });

  it("keeps an empty selection — 'nothing qualified' is a real answer", () => {
    expect(readSelection({ articles: [] })).toHaveLength(0);
  });

  // SAP-2892: an unusable reply must never read as an empty selection, which
  // routes the run to the `noNews` terminal as though the model had answered.
  it("throws when the response carries no structured selection", () => {
    expect(() => readSelection(undefined)).toThrow();
    expect(() => readSelection(null)).toThrow();
    expect(() => readSelection("Here you go: [...]")).toThrow();
  });

  it("throws on items missing required keys", () => {
    expect(() => readSelection({ articles: [{ title: "T" }] })).toThrow();
  });

  it("throws on more than 5 items", () => {
    expect(() =>
      readSelection({ articles: Array.from({ length: 6 }, () => article) }),
    ).toThrow();
  });
});
