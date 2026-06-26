# search

Find information across the web and beyond — searching the web, reading pages,
and looking up professional emails. More operations land in this namespace as
they ship; today it offers `webSearch`, `scrape`, and `emailSearch`.

## `webSearch` — search the web

Search the web and get a synthesized answer plus supporting results:

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const hits = await sapiom.search.webSearch({ query: "what is an LLM agent?" });
hits.answer; // a synthesized answer
hits.results; // supporting results: [{ title, url, snippet }]
```

Ambient import works too: `import { search } from "@sapiom/tools"`.

### Choosing what you get back

Pass `intent: "links"` for a list of relevant results instead of a synthesized
answer, and `depth: "deep"` for a more thorough search:

```typescript
const hits = await sapiom.search.webSearch({
  query: "best practices for prompt caching",
  intent: "links",
  depth: "deep",
});
hits.results; // [{ title, url, snippet }, …]
```

### Input

- `query` (required) — what to search for.
- `depth` (optional) — `"standard"` (default) or `"deep"` for a more thorough
  search.
- `intent` (optional) — `"answer"` (default) for a synthesized answer plus
  supporting results, or `"links"` for a list of relevant results.

### Result

```typescript
{
  query: string;          // the query that was searched
  answer?: string;        // a synthesized answer (present for intent: "answer")
  results: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
}
```

## `scrape` — read a page

Read a page and return its content. By default you get markdown:

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const page = await sapiom.search.scrape({ url: "https://example.com" });
page.markdown; // the page content as markdown
page.metadata.title; // the page title
```

Ambient import works too: `import { search } from "@sapiom/tools"`.

### Choosing formats

Pass `formats` to get HTML, raw HTML, a screenshot, or the page's links — alone
or alongside markdown:

```typescript
const page = await sapiom.search.scrape({
  url: "https://example.com",
  formats: ["markdown", "html", "links"],
});
page.html; // cleaned HTML
page.links; // string[] of links found on the page
```

Each requested format is returned as its own field; a field is present only when
that format was requested.

### Input

- `url` (required) — the page to read.
- `formats` (optional) — any of `"markdown" | "html" | "rawHtml" | "screenshot" |
"links"`. Defaults to `["markdown"]`.
- `onlyMainContent` (optional) — return only the main content, dropping
  navigation, headers, footers, and ads.
- `waitFor` (optional) — milliseconds to wait before reading, for content
  rendered by JavaScript.

### Result

```typescript
{
  url: string;            // the URL that was read
  markdown?: string;
  html?: string;
  rawHtml?: string;
  screenshot?: string;
  links?: string[];
  metadata: {
    title?: string;
    description?: string;
    language?: string;
    sourceUrl?: string;
    statusCode?: number;
  };
}
```

`scrape` works on HTML pages and common documents (PDF, DOCX, TXT). It is not
meant for images, video, or archives.

## `emailSearch` — work with professional emails

`emailSearch` groups three operations: `findEmail` (find a person's email),
`verifyEmail` (check an address is deliverable), and `domainSearch` (discover the
emails published at a company domain).

### `findEmail` — find a person's email

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const found = await sapiom.search.emailSearch.findEmail({
  domain: "example.com",
  firstName: "Ada",
  lastName: "Lovelace",
});
found.email; // the discovered email, or null when none was found
found.score; // confidence (0–100)
```

You must give enough to identify both the person and where they work: a `domain`
**or** `company`, **and** either a `fullName` **or** both `firstName` and
`lastName`. Calling without a valid combination throws `SearchHttpError` before
any request is made.

```typescript
const found = await sapiom.search.emailSearch.findEmail({
  company: "Example Inc",
  fullName: "Ada Lovelace",
});
```

#### Input

- `domain` — company domain, e.g. `"example.com"` (provide `domain` or `company`).
- `company` — company name (alternative to `domain`).
- `firstName` / `lastName` — the person's name (provide both, or use `fullName`).
- `fullName` — the person's full name (alternative to `firstName` + `lastName`).

#### Result

```typescript
{
  email: string | null;   // null when not found
  score?: number;         // confidence 0–100
  firstName?: string;
  lastName?: string;
  position?: string;
  company?: string;
  linkedinUrl?: string;
  verification?: { status?: string; date?: string };
}
```

### `verifyEmail` — verify deliverability

```typescript
const check = await sapiom.search.emailSearch.verifyEmail({
  email: "ada@example.com",
});
check.status; // deliverability status
check.score; // confidence 0–100
```

#### Input

- `email` (required) — the address to verify.

#### Result

```typescript
{
  email: string;
  status?: string;
  result?: string;
  score?: number;
  smtpCheck?: boolean;
  acceptAll?: boolean;    // domain accepts any address (a positive is weak)
  disposable?: boolean;
  webmail?: boolean;
}
```

### `domainSearch` — discover emails at a domain

```typescript
const hits = await sapiom.search.emailSearch.domainSearch({
  domain: "example.com",
  limit: 5,
  seniority: ["executive"],
  department: ["engineering", "sales"],
});
hits.emails; // [{ email, type?, confidence?, firstName?, ... }, …]
hits.pattern; // the detected email pattern, e.g. "{first}.{last}"
```

#### Input

- `domain` (required) — the company domain to search.
- `limit` — max emails to return (max 100, default 10).
- `type` — `"personal"` or `"generic"`.
- `seniority` — any of `"junior" | "senior" | "executive"`.
- `department` — one or more departments, e.g. `["engineering", "sales"]`.

#### Result

```typescript
{
  domain: string;
  organization?: string;
  pattern?: string;
  acceptAll?: boolean;
  emails: Array<{
    email: string;
    type?: string;
    confidence?: number;
    firstName?: string;
    lastName?: string;
    position?: string;
    department?: string;
    seniority?: string;
  }>;
}
```

## Gotchas

- **Failed requests throw `SearchHttpError`** (carries `status` + parsed `body`),
  exported from `@sapiom/tools`.
- **`findEmail` validates its inputs before calling.** An under-specified lookup
  (missing the org or the person) throws `SearchHttpError` immediately, with no
  network round-trip.
