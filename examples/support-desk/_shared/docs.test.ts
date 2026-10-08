import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "./db";
import { memoryDb } from "./db";
import {
  MAX_INDEX_BYTES,
  MAX_PAGE_BYTES,
  MAX_PAGE_CHARS,
  TTL_MS,
  canonicalPageUrl,
  getIndex,
  getPage,
  httpFetcher,
  isDocsUrl,
  localFetcher,
  parseDocsSource,
  parseLlmsTxt,
  renderIndex,
} from "./docs";

const SOURCE = parseDocsSource("https://docs.example.com");
const INDEX_URL = SOURCE.indexUrl;

describe("parseDocsSource", () => {
  it.each([
    ["https://docs.example.com", "https://docs.example.com/llms.txt"],
    ["https://docs.example.com/", "https://docs.example.com/llms.txt"],
    ["https://example.com/help/", "https://example.com/help/llms.txt"],
    ["https://docs.example.com/llms.txt", "https://docs.example.com/llms.txt"],
    [
      "https://docs.example.com/llms-full.txt",
      "https://docs.example.com/llms-full.txt",
    ],
  ])("%s reads its index from %s", (url, index) => {
    expect(parseDocsSource(url)).toEqual({
      origin: new URL(url).origin,
      indexUrl: index,
    });
  });

  it.each([
    "http://docs.example.com",
    "https://user:pw@docs.example.com",
    "https://docs.example.com/?q=1",
    "https://docs.example.com/#x",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => parseDocsSource(url)).toThrow();
  });
});

const LLMS = `# Example

> An example product

## Docs

### Start here
- [Quickstart](https://docs.example.com/agents/quick-start): Set up the product.
- [Router](https://docs.example.com/router): Call the router.
- [Off site](https://evil.example/guide): Not ours.
- [No description](https://docs.example.com/guides/deploy)
- [Dup](https://docs.example.com/router.md): same page as Router.
- **Build an agent:** not a link entry.
`;

describe("parseLlmsTxt", () => {
  it("reads title, url and description, and drops other origins and duplicates", () => {
    expect(parseLlmsTxt(LLMS, SOURCE)).toEqual([
      {
        title: "Quickstart",
        url: "https://docs.example.com/agents/quick-start",
        description: "Set up the product.",
      },
      {
        title: "Router",
        url: "https://docs.example.com/router",
        description: "Call the router.",
      },
      {
        title: "No description",
        url: "https://docs.example.com/guides/deploy",
        description: "",
      },
    ]);
  });

  it("renders one line per page", () => {
    expect(renderIndex(parseLlmsTxt(LLMS, SOURCE)).split("\n")).toHaveLength(3);
  });
});

describe("origin allowlist", () => {
  it.each([
    ["https://docs.example.com/guides/deploy", true],
    ["https://docs.example.com/guides/deploy.md", true],
    ["http://docs.example.com/guides/deploy", false],
    ["https://docs.example.com.evil.example/x", false],
    ["https://evil.example/https://docs.example.com/x", false],
    ["https://user@docs.example.com/x", false],
    ["https://docs.example.com:8443/x", false],
    ["//docs.example.com/x", false],
    ["not a url", false],
  ])("isDocsUrl(%s) is %s", (url, ok) => {
    expect(isDocsUrl(url, SOURCE)).toBe(ok);
  });

  it("canonicalises to the page url without .md, query or fragment", () => {
    expect(
      canonicalPageUrl(
        "https://docs.example.com/guides/deploy.md?a=1#b",
        SOURCE,
      ),
    ).toBe("https://docs.example.com/guides/deploy");
    expect(canonicalPageUrl("https://docs.example.com/", SOURCE)).toBeNull();
    expect(canonicalPageUrl("https://evil.example/x", SOURCE)).toBeNull();
  });

  it("the http fetcher refuses another origin before any request", async () => {
    await expect(httpFetcher(SOURCE)("https://evil.example/x")).rejects.toThrow(
      "refusing",
    );
  });

  describe("response size", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("stops reading an endless body at the page cap and cancels the stream", async () => {
      let pulled = 0;
      let cancelled = false;
      const chunk = new Uint8Array(16 * 1024).fill(97);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));
      const text = await httpFetcher(SOURCE)(
        "https://docs.example.com/guides/deploy.md",
      );
      expect(text.length).toBe(MAX_PAGE_BYTES);
      expect(cancelled).toBe(true);
      expect(pulled).toBeLessThan(MAX_PAGE_BYTES + 4 * chunk.byteLength);
    });

    it("gives the index a larger bound than a page", async () => {
      const big = new Uint8Array(MAX_INDEX_BYTES + 5000).fill(97);
      vi.stubGlobal("fetch", async () => new Response(big, { status: 200 }));
      expect((await httpFetcher(SOURCE)(INDEX_URL)).length).toBe(
        MAX_INDEX_BYTES,
      );
    });
  });

  it("getPage refuses a url off the docs origin without fetching", async () => {
    const db = await memoryDb();
    const calls: string[] = [];
    await expect(
      getPage(db, SOURCE, "https://evil.example/x", {
        fetcher: async (u) => (calls.push(u), "x"),
      }),
    ).rejects.toThrow("not a docs page");
    expect(calls).toEqual([]);
  });
});

describe("cache", () => {
  let db: Db;
  let calls: string[];
  let now: Date;
  let body: string;
  const deps = () => ({
    fetcher: async (url: string) => {
      calls.push(url);
      if (body === "FAIL") throw new Error("docs down");
      return body;
    },
    now: () => now,
  });
  beforeEach(async () => {
    db = await memoryDb();
    calls = [];
    now = new Date("2026-10-02T10:00:00Z");
    body = "# Deploy\nv1";
  });

  const PAGE = "https://docs.example.com/guides/deploy";

  it("fetches the .md twin once within the TTL", async () => {
    expect(await getPage(db, SOURCE, PAGE, deps())).toBe("# Deploy\nv1");
    body = "v2";
    now = new Date(now.getTime() + TTL_MS - 1000);
    expect(await getPage(db, SOURCE, `${PAGE}.md`, deps())).toBe(
      "# Deploy\nv1",
    );
    expect(calls).toEqual([`${PAGE}.md`]);
  });

  it("refetches after the TTL", async () => {
    await getPage(db, SOURCE, PAGE, deps());
    body = "v2";
    now = new Date(now.getTime() + TTL_MS + 1000);
    expect(await getPage(db, SOURCE, PAGE, deps())).toBe("v2");
    expect(calls).toHaveLength(2);
  });

  it("serves an expired copy when the refetch fails, and throws when there is none", async () => {
    await expect(
      getPage(db, SOURCE, "https://docs.example.com/other", {
        ...deps(),
        fetcher: async () => {
          throw new Error("down");
        },
      }),
    ).rejects.toThrow("down");
    await getPage(db, SOURCE, PAGE, deps());
    body = "FAIL";
    now = new Date(now.getTime() + TTL_MS * 5);
    expect(await getPage(db, SOURCE, PAGE, deps())).toBe("# Deploy\nv1");
  });

  it("caps a page and says it was cut", async () => {
    body = "y".repeat(MAX_PAGE_CHARS + 5000);
    const page = await getPage(db, SOURCE, PAGE, deps());
    expect(page.length).toBeLessThan(MAX_PAGE_CHARS + 50);
    expect(page.endsWith("[page truncated]")).toBe(true);
  });

  it("does not cache an index with no pages, and serves the stale valid copy", async () => {
    body = LLMS;
    expect(await getIndex(db, SOURCE, deps())).toHaveLength(3);
    body = "Service unavailable";
    now = new Date(now.getTime() + TTL_MS * 2);
    expect(await getIndex(db, SOURCE, deps())).toHaveLength(3);
    // The bad body was not stored, so the next call refetches rather than serving it for an hour.
    body = LLMS + "- [New](https://docs.example.com/new): n.\n";
    expect(await getIndex(db, SOURCE, deps())).toHaveLength(4);
  });

  it("throws on an empty index when there is no copy to fall back to", async () => {
    body = "Service unavailable";
    await expect(getIndex(db, SOURCE, deps())).rejects.toThrow("no pages");
  });

  it("caches and parses the index", async () => {
    body = LLMS;
    expect(await getIndex(db, SOURCE, deps())).toHaveLength(3);
    await getIndex(db, SOURCE, deps());
    expect(calls).toEqual([INDEX_URL]);
  });

  it("the local fetcher serves a stub index and pages without a network", async () => {
    expect(
      parseLlmsTxt(await localFetcher(SOURCE)(INDEX_URL), SOURCE).length,
    ).toBeGreaterThan(0);
    expect(await localFetcher(SOURCE)(`${PAGE}.md`)).toContain("not fetched");
  });
});
