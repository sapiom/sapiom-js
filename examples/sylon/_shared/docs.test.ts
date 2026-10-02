import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "./db";
import { memoryDb } from "./db";
import {
  INDEX_URL,
  MAX_PAGE_CHARS,
  TTL_MS,
  canonicalPageUrl,
  getIndex,
  getPage,
  httpFetcher,
  isDocsUrl,
  localFetcher,
  parseLlmsTxt,
  renderIndex,
} from "./docs";

const LLMS = `# Sapiom

> Build agents

## Docs

### Start here
- [Quickstart](https://docs.sapiom.ai/agents/quick-start): Set up Sapiom.
- [Router](https://docs.sapiom.ai/router): Call the router.
- [Off site](https://evil.example/guide): Not ours.
- [No description](https://docs.sapiom.ai/guides/deploy)
- [Dup](https://docs.sapiom.ai/router.md): same page as Router.
- **Build an agent:** not a link entry.
`;

describe("parseLlmsTxt", () => {
  it("reads title, url and description, and drops other origins and duplicates", () => {
    expect(parseLlmsTxt(LLMS)).toEqual([
      {
        title: "Quickstart",
        url: "https://docs.sapiom.ai/agents/quick-start",
        description: "Set up Sapiom.",
      },
      {
        title: "Router",
        url: "https://docs.sapiom.ai/router",
        description: "Call the router.",
      },
      {
        title: "No description",
        url: "https://docs.sapiom.ai/guides/deploy",
        description: "",
      },
    ]);
  });

  it("renders one line per page", () => {
    expect(renderIndex(parseLlmsTxt(LLMS)).split("\n")).toHaveLength(3);
  });
});

describe("origin allowlist", () => {
  it.each([
    ["https://docs.sapiom.ai/guides/deploy", true],
    ["https://docs.sapiom.ai/guides/deploy.md", true],
    ["http://docs.sapiom.ai/guides/deploy", false],
    ["https://docs.sapiom.ai.evil.example/x", false],
    ["https://evil.example/https://docs.sapiom.ai/x", false],
    ["https://user@docs.sapiom.ai/x", false],
    ["https://docs.sapiom.ai:8443/x", false],
    ["//docs.sapiom.ai/x", false],
    ["not a url", false],
  ])("isDocsUrl(%s) is %s", (url, ok) => {
    expect(isDocsUrl(url)).toBe(ok);
  });

  it("canonicalises to the page url without .md, query or fragment", () => {
    expect(
      canonicalPageUrl("https://docs.sapiom.ai/guides/deploy.md?a=1#b"),
    ).toBe("https://docs.sapiom.ai/guides/deploy");
    expect(canonicalPageUrl("https://docs.sapiom.ai/")).toBeNull();
    expect(canonicalPageUrl("https://evil.example/x")).toBeNull();
  });

  it("the http fetcher refuses another origin before any request", async () => {
    await expect(httpFetcher("https://evil.example/x")).rejects.toThrow(
      "refusing",
    );
  });

  it("getPage refuses a url off the docs origin without fetching", async () => {
    const db = await memoryDb();
    const calls: string[] = [];
    await expect(
      getPage(db, "https://evil.example/x", {
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

  const PAGE = "https://docs.sapiom.ai/guides/deploy";

  it("fetches the .md twin once within the TTL", async () => {
    expect(await getPage(db, PAGE, deps())).toBe("# Deploy\nv1");
    body = "v2";
    now = new Date(now.getTime() + TTL_MS - 1000);
    expect(await getPage(db, `${PAGE}.md`, deps())).toBe("# Deploy\nv1");
    expect(calls).toEqual([`${PAGE}.md`]);
  });

  it("refetches after the TTL", async () => {
    await getPage(db, PAGE, deps());
    body = "v2";
    now = new Date(now.getTime() + TTL_MS + 1000);
    expect(await getPage(db, PAGE, deps())).toBe("v2");
    expect(calls).toHaveLength(2);
  });

  it("serves an expired copy when the refetch fails, and throws when there is none", async () => {
    await expect(
      getPage(db, "https://docs.sapiom.ai/other", {
        ...deps(),
        fetcher: async () => {
          throw new Error("down");
        },
      }),
    ).rejects.toThrow("down");
    await getPage(db, PAGE, deps());
    body = "FAIL";
    now = new Date(now.getTime() + TTL_MS * 5);
    expect(await getPage(db, PAGE, deps())).toBe("# Deploy\nv1");
  });

  it("caps a page and says it was cut", async () => {
    body = "y".repeat(MAX_PAGE_CHARS + 5000);
    const page = await getPage(db, PAGE, deps());
    expect(page.length).toBeLessThan(MAX_PAGE_CHARS + 50);
    expect(page.endsWith("[page truncated]")).toBe(true);
  });

  it("caches and parses the index", async () => {
    body = LLMS;
    expect(await getIndex(db, deps())).toHaveLength(3);
    await getIndex(db, deps());
    expect(calls).toEqual([INDEX_URL]);
  });

  it("the local fetcher serves a stub index and pages without a network", async () => {
    expect(parseLlmsTxt(await localFetcher(INDEX_URL)).length).toBeGreaterThan(
      0,
    );
    expect(await localFetcher(`${PAGE}.md`)).toContain("not fetched");
  });
});
