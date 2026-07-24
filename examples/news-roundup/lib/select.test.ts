import { describe, expect, it } from "vitest";
import { buildSelectionPrompt, parseSelection } from "./select.js";

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
});

describe("parseSelection", () => {
  const good = JSON.stringify([
    { title: "T", url: "https://a.example/1", summary: "S.", imagePrompt: "P" },
  ]);
  it("parses a bare JSON array", () => {
    expect(parseSelection(good)).toHaveLength(1);
  });
  it("parses an array wrapped in prose/code fences", () => {
    expect(parseSelection("Here you go:\n```json\n" + good + "\n```")).toHaveLength(1);
  });
  it("rejects output without a JSON array", () => {
    expect(() => parseSelection("no json here")).toThrow();
  });
  it("rejects items missing required keys", () => {
    expect(() => parseSelection('[{"title":"T"}]')).toThrow();
  });
  it("rejects more than 5 items", () => {
    const six = JSON.stringify(Array.from({ length: 6 }, () => JSON.parse(good)[0]));
    expect(() => parseSelection(six)).toThrow();
  });
});
