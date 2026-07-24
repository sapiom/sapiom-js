import { describe, expect, it } from "vitest";
import {
  buildIndexPage,
  buildRoundupPage,
  imageStorageName,
  pageStorageName,
  roundupDatesFromFileNames,
} from "./html.js";

const PREFIX = "news-roundup/polsia/";

describe("storage names", () => {
  it("builds page and image names", () => {
    expect(pageStorageName(PREFIX, "2026-07-22")).toBe("news-roundup/polsia/pages/2026-07-22.html");
    expect(imageStorageName(PREFIX, "2026-07-22", 1)).toBe("news-roundup/polsia/images/2026-07-22-1.png");
  });
});

describe("buildRoundupPage", () => {
  const page = buildRoundupPage({
    companyName: "Polsia",
    runDate: "2026-07-22",
    articles: [
      { title: "Big <news>", sourceUrl: "https://a.example/1", summary: "Short & sweet.", imageFileName: `${PREFIX}images/2026-07-22-1.png` },
      { title: "No image story", sourceUrl: "https://a.example/2", summary: "Text only.", imageFileName: null },
    ],
  });
  it("references images relative to /pages/", () => {
    expect(page).toContain('src="../images/2026-07-22-1.png"');
  });
  it("escapes HTML in article fields", () => {
    expect(page).toContain("Big &lt;news&gt;");
    expect(page).toContain("Short &amp; sweet.");
    expect(page).not.toContain("Big <news>");
  });
  it("renders a text-only card when imageFileName is null", () => {
    expect(page).toContain("No image story");
    const imgCount = (page.match(/<img /g) ?? []).length;
    expect(imgCount).toBe(1);
  });
  it("links each source", () => {
    expect(page).toContain('href="https://a.example/1"');
  });
  it("does not link non-http(s) source URLs", () => {
    const p = buildRoundupPage({
      companyName: "Polsia",
      runDate: "2026-07-22",
      articles: [
        { title: "Evil", sourceUrl: "javascript:alert(1)", summary: "x", imageFileName: null },
      ],
    });
    expect(p).not.toContain("javascript:");
    expect(p).toContain("Evil");
  });
});

describe("roundupDatesFromFileNames", () => {
  it("extracts unique page dates sorted descending, ignoring other files", () => {
    const dates = roundupDatesFromFileNames(
      [
        `${PREFIX}pages/2026-07-15.html`,
        `${PREFIX}pages/2026-07-22.html`,
        `${PREFIX}pages/2026-07-22.html`,
        `${PREFIX}images/2026-07-22-1.png`,
        "other/pages/2026-01-01.html",
      ],
      PREFIX,
    );
    expect(dates).toEqual(["2026-07-22", "2026-07-15"]);
  });
});

describe("buildIndexPage", () => {
  it("links every date page", () => {
    const html = buildIndexPage("Polsia", ["2026-07-22", "2026-07-15"]);
    expect(html).toContain('href="pages/2026-07-22.html"');
    expect(html).toContain('href="pages/2026-07-15.html"');
    expect(html).toContain("Polsia");
  });
});
