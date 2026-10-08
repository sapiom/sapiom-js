import { describe, expect, it } from "vitest";

import {
  LONG_PASTE_CHARS,
  LONG_PASTE_LINES,
  classifyPaste,
  countWords,
  extractUrls,
  isOnlyUrls,
  pastedDocumentName,
  urlLabel,
} from "./composer-intake";

describe("extractUrls", () => {
  it("finds distinct http(s) links in order and drops sentence punctuation", () => {
    expect(
      extractUrls(
        "See https://example.com/spec, then (https://docs.example.com/a). Again https://example.com/spec.",
      ),
    ).toEqual(["https://example.com/spec", "https://docs.example.com/a"]);
  });

  it("keeps a balanced paren inside a link", () => {
    expect(extractUrls("https://en.wikipedia.org/wiki/Agent_(software)")).toEqual([
      "https://en.wikipedia.org/wiki/Agent_(software)",
    ]);
  });

  it("ignores non-http schemes and bare words", () => {
    expect(extractUrls("ftp://x.example and example.com and mailto:a@b.c")).toEqual([]);
  });
});

describe("classifyPaste", () => {
  it("lists a paste that is only links as sources", () => {
    expect(classifyPaste("https://a.example/one\nhttps://b.example/two")).toEqual({
      kind: "links",
      urls: ["https://a.example/one", "https://b.example/two"],
    });
    expect(isOnlyUrls("  https://a.example  ")).toBe(true);
  });

  it("types a sentence that merely contains a link", () => {
    expect(classifyPaste("Read https://a.example first, then build.")).toEqual({
      kind: "text",
    });
  });

  it("attaches a long paste as a document, by characters or by lines", () => {
    expect(classifyPaste("x".repeat(LONG_PASTE_CHARS + 1))).toEqual({
      kind: "document",
    });
    expect(
      classifyPaste(Array.from({ length: LONG_PASTE_LINES + 1 }, () => "line").join("\n")),
    ).toEqual({ kind: "document" });
    expect(classifyPaste("x".repeat(LONG_PASTE_CHARS))).toEqual({ kind: "text" });
  });

  it("never classifies an empty paste as links", () => {
    expect(classifyPaste("   ")).toEqual({ kind: "text" });
  });
});

describe("pastedDocumentName", () => {
  it("numbers pasted documents", () => {
    expect(pastedDocumentName(1)).toBe("pasted-1.md");
    expect(pastedDocumentName(3)).toBe("pasted-3.md");
  });
});

describe("source chip labels", () => {
  it("shows a link as host and path, without scheme or www", () => {
    expect(urlLabel("https://www.acme.com/blog/changelog?x=1")).toBe("acme.com/blog/changelog");
    expect(urlLabel("https://globex.example/")).toBe("globex.example");
    expect(urlLabel("not a url")).toBe("not a url");
  });

  it("counts the words of a pasted document", () => {
    expect(countWords("one two  three\nfour")).toBe(4);
    expect(countWords("   ")).toBe(0);
  });
});
