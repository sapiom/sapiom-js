#!/usr/bin/env node
/**
 * Cross-environment E2E for the `search` capability — runs the BUILT package
 * (`../dist/esm/index.js`) against the live services, exactly as a consumer of
 * the published artifact would.
 *
 * Usage:
 *   node search-e2e.mjs <dev|prod>
 *
 * Required env (per target):
 *   dev  → SAPIOM_DEV_API_KEY      (calls api.sapiom.dev + *.services.sapiom.dev)
 *   prod → SAPIOM_API_KEY          (calls api.sapiom.ai  + *.services.sapiom.ai)
 *
 * Optional env:
 *   RUN_PAID=1   also run the single paid happy-path call per method (otherwise
 *                only the always-free checks run).
 *
 * What it does:
 *   - FREE checks (always): each method is fed bad input and must throw the typed
 *     SearchHttpError and never produce a 5xx (assert 4xx-never-5xx). findEmail's
 *     missing-combo must throw BEFORE any network call.
 *   - PAID checks (RUN_PAID=1): one real call per method; asserts the normalized
 *     shape and that no provider name / no `servedBy` leaks into the JSON.
 *   - CHARGE-ON-REJECT (with RUN_PAID, paid methods): snapshot the transaction
 *     count, fire a deliberately-rejected (4xx) request, confirm the count did
 *     NOT increase (a rejected request must not settle).
 *
 * Prints a per-method / per-check PASS / FAIL / SKIP table and exits non-zero on
 * any FAIL. Never prints the API key.
 *
 * NOTE: this script makes live (and, with RUN_PAID=1, billable) calls. The
 * orchestrator runs it; it is not run automatically.
 */

// ---------------------------------------------------------------------------
// Target + credential resolution (must happen BEFORE importing the SDK so the
// per-method base-URL env vars are read at module load).
// ---------------------------------------------------------------------------

const target = (process.argv[2] || "").toLowerCase();
if (target !== "dev" && target !== "prod") {
  console.error("usage: node search-e2e.mjs <dev|prod>");
  process.exit(2);
}

const RUN_PAID = process.env.RUN_PAID === "1";

const HOSTS = {
  dev: {
    backend: "https://api.sapiom.dev",
    scrape: "https://firecrawl.services.sapiom.dev",
    webSearch: "https://api.sapiom.dev",
    email: "https://hunter.services.sapiom.dev",
    keyVar: "SAPIOM_DEV_API_KEY",
  },
  prod: {
    backend: "https://api.sapiom.ai",
    scrape: "https://firecrawl.services.sapiom.ai",
    webSearch: "https://api.sapiom.ai",
    email: "https://hunter.services.sapiom.ai",
    keyVar: "SAPIOM_API_KEY",
  },
}[target];

const apiKey = process.env[HOSTS.keyVar];
console.log(`target: ${target}`);
console.log(`key resolved: ${apiKey ? "yes" : "no"} (from ${HOSTS.keyVar})`);
console.log(`paid happy-paths: ${RUN_PAID ? "ON (RUN_PAID=1)" : "off"}`);
if (!apiKey) {
  console.error(`Missing ${HOSTS.keyVar} — cannot run.`);
  process.exit(2);
}

// Point each method at the correct host for this target. The SDK reads these at
// import time, so they MUST be set before the dynamic import below.
process.env.SAPIOM_SCRAPE_URL = HOSTS.scrape;
process.env.SAPIOM_SEARCH_URL = HOSTS.webSearch;
process.env.SAPIOM_EMAIL_SEARCH_URL = HOSTS.email;

const { createClient, SearchHttpError } = await import("../dist/esm/index.js");
const sapiom = createClient({ apiKey });

// ---------------------------------------------------------------------------
// Tiny result table.
// ---------------------------------------------------------------------------

const rows = [];
function record(method, check, status, detail = "") {
  rows.push({ method, check, status, detail });
  const tag =
    status === "PASS" ? "PASS " : status === "FAIL" ? "FAIL " : "SKIP ";
  console.log(
    `  [${tag}] ${method} :: ${check}${detail ? ` — ${detail}` : ""}`,
  );
}

/** Recursively assert no provider name and no `servedBy` appears in a payload. */
const FORBIDDEN = ["hunter", "firecrawl", "linkup", "you.com", "youcom"];
function findLeak(value, path = "$") {
  if (value == null) return null;
  if (typeof value === "string") {
    const low = value.toLowerCase();
    for (const term of FORBIDDEN) {
      // Only flag forbidden terms in *values* that look like leaked identifiers,
      // not arbitrary substrings of legitimate content (e.g. a scraped page that
      // happens to mention a word). We flag short, identifier-ish values only.
      if (low === term) return `${path} === "${value}"`;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findLeak(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k.toLowerCase() === "servedby")
        return `${path}.${k} (servedBy present)`;
      for (const term of FORBIDDEN) {
        if (k.toLowerCase().includes(term))
          return `${path}.${k} (key leaks "${term}")`;
      }
      const hit = findLeak(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

/** Run an op expected to be REJECTED; assert it throws SearchHttpError with a
 *  4xx status (never a 5xx, never a non-typed error). Returns true on PASS. */
async function expectRejected(method, check, fn) {
  try {
    await fn();
    record(method, check, "FAIL", "expected a rejection, got success");
    return false;
  } catch (err) {
    if (!(err instanceof SearchHttpError)) {
      record(
        method,
        check,
        "FAIL",
        `threw ${err?.name || typeof err}, not SearchHttpError`,
      );
      return false;
    }
    const s = err.status;
    if (typeof s === "number" && s >= 500) {
      record(method, check, "FAIL", `5xx (${s}) — a real hole`);
      return false;
    }
    if (typeof s === "number" && s >= 400 && s < 500) {
      record(method, check, "PASS", `4xx (${s}) typed SearchHttpError`);
      return true;
    }
    // Status outside 4xx/5xx (e.g. the pre-fetch guard uses 400) — still a typed
    // SearchHttpError, which is the contract.
    record(method, check, "PASS", `typed SearchHttpError (status ${s})`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Charge-on-reject: snapshot the transaction count, fire a 4xx, confirm no
// settlement. Uses BARE `GET /v1/transactions` (the only form that 200s) and
// counts the JSON:API `data` array.
// ---------------------------------------------------------------------------

async function transactionCount() {
  const res = await fetch(`${HOSTS.backend}/v1/transactions`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/transactions → ${res.status}`);
  }
  const body = await res.json();
  if (Array.isArray(body?.data)) return body.data.length;
  if (Array.isArray(body)) return body.length;
  throw new Error("unexpected /v1/transactions shape (no data array)");
}

async function chargeOnReject(method, rejectFn) {
  const check = "charge-on-reject (4xx must not settle)";
  let before;
  try {
    before = await transactionCount();
  } catch (err) {
    record(method, check, "FAIL", `count(before) failed: ${err.message}`);
    return;
  }
  // Fire a deliberately-rejected request. We expect it to throw; that's fine.
  try {
    await rejectFn();
    // If it somehow succeeded, the probe was not actually rejected — inconclusive.
    record(method, check, "FAIL", "reject probe unexpectedly succeeded");
    return;
  } catch {
    /* expected */
  }
  // Allow a brief moment for any (incorrect) async settlement to land.
  await new Promise((r) => setTimeout(r, 1500));
  let after;
  try {
    after = await transactionCount();
  } catch (err) {
    record(method, check, "FAIL", `count(after) failed: ${err.message}`);
    return;
  }
  if (after > before) {
    record(method, check, "FAIL", `count rose ${before}→${after} (settled!)`);
  } else {
    record(method, check, "PASS", `count steady (${before})`);
  }
}

// ---------------------------------------------------------------------------
// Per-method suites.
// ---------------------------------------------------------------------------

async function runScrape() {
  const m = "scrape";
  // FREE: a malformed URL must be rejected 4xx-never-5xx.
  await expectRejected(m, "bad url rejected (4xx never 5xx)", () =>
    sapiom.search.scrape({ url: "not-a-valid-url" }),
  );

  if (!RUN_PAID) {
    record(m, "paid happy-path", "SKIP", "RUN_PAID not set");
    record(m, "charge-on-reject", "SKIP", "RUN_PAID not set");
    return;
  }
  // PAID: one real scrape; assert shape + no leak.
  try {
    const out = await sapiom.search.scrape({ url: "https://example.com" });
    const ok =
      out && typeof out.url === "string" && typeof out.metadata === "object";
    record(
      m,
      "paid happy-path shape",
      ok ? "PASS" : "FAIL",
      ok ? "" : "missing url/metadata",
    );
    const leak = findLeak(out);
    record(m, "no provider/servedBy leak", leak ? "FAIL" : "PASS", leak || "");
  } catch (err) {
    record(m, "paid happy-path shape", "FAIL", err.message);
  }
  await chargeOnReject(m, () =>
    sapiom.search.scrape({ url: "not-a-valid-url" }),
  );
}

async function runWebSearch() {
  const m = "webSearch";
  if (target !== "dev") {
    record(m, "all checks", "SKIP", "SKIPPED (prod endpoint not released)");
    return;
  }
  // FREE: empty query must be rejected 4xx-never-5xx.
  await expectRejected(m, "empty query rejected (4xx never 5xx)", () =>
    sapiom.search.webSearch({ query: "" }),
  );

  if (!RUN_PAID) {
    record(m, "paid happy-path", "SKIP", "RUN_PAID not set");
    record(m, "charge-on-reject", "SKIP", "RUN_PAID not set");
    return;
  }
  try {
    const out = await sapiom.search.webSearch({
      query: "what is an LLM agent?",
    });
    const ok =
      out && typeof out.query === "string" && Array.isArray(out.results);
    record(
      m,
      "paid happy-path shape",
      ok ? "PASS" : "FAIL",
      ok ? "" : "missing query/results",
    );
    const leak = findLeak(out);
    record(m, "no provider/servedBy leak", leak ? "FAIL" : "PASS", leak || "");
  } catch (err) {
    record(m, "paid happy-path shape", "FAIL", err.message);
  }
  await chargeOnReject(m, () => sapiom.search.webSearch({ query: "" }));
}

async function runFindEmail() {
  const m = "emailSearch.findEmail";
  // FREE: a missing required combination must throw BEFORE any network call.
  // (We can't directly observe "no fetch" here, but the typed throw is the
  // contract; the unit tests prove the no-fetch property.)
  await expectRejected(m, "missing-combo throws pre-fetch", () =>
    sapiom.search.emailSearch.findEmail({ domain: "example.com" }),
  );

  if (!RUN_PAID) {
    record(m, "paid happy-path", "SKIP", "RUN_PAID not set");
    record(m, "charge-on-reject", "SKIP", "RUN_PAID not set");
    return;
  }
  try {
    const out = await sapiom.search.emailSearch.findEmail({
      domain: "stripe.com",
      fullName: "Patrick Collison",
    });
    // `email` is `string | null` — both are valid shapes (null = not found).
    const ok = out && (typeof out.email === "string" || out.email === null);
    record(
      m,
      "paid happy-path shape",
      ok ? "PASS" : "FAIL",
      ok ? `email=${out.email}` : "no email field",
    );
    const leak = findLeak(out);
    record(m, "no provider/servedBy leak", leak ? "FAIL" : "PASS", leak || "");
  } catch (err) {
    record(m, "paid happy-path shape", "FAIL", err.message);
  }
  // A reject that reaches the network: a garbage domain that the service 4xxs on.
  // (The pre-fetch guard never settles, so use a network-level 4xx here.)
  await chargeOnReject(m, () =>
    sapiom.search.emailSearch.findEmail({
      domain: "@@@invalid-domain@@@",
      fullName: "No Body",
    }),
  );
}

async function runVerifyEmail() {
  const m = "emailSearch.verifyEmail";
  // FREE: empty email throws pre-fetch (typed).
  await expectRejected(m, "empty email rejected (typed)", () =>
    sapiom.search.emailSearch.verifyEmail({ email: "" }),
  );

  if (!RUN_PAID) {
    record(m, "paid happy-path", "SKIP", "RUN_PAID not set");
    return;
  }
  try {
    const out = await sapiom.search.emailSearch.verifyEmail({
      email: "info@stripe.com",
    });
    const ok = out && typeof out.email === "string";
    record(
      m,
      "paid happy-path shape",
      ok ? "PASS" : "FAIL",
      ok ? `status=${out.status}` : "no email field",
    );
    const leak = findLeak(out);
    record(m, "no provider/servedBy leak", leak ? "FAIL" : "PASS", leak || "");
  } catch (err) {
    record(m, "paid happy-path shape", "FAIL", err.message);
  }
}

async function runDomainSearch() {
  const m = "emailSearch.domainSearch";
  // FREE: a bad limit (out of range) must be rejected 4xx-never-5xx.
  await expectRejected(m, "bad limit rejected (4xx never 5xx)", () =>
    sapiom.search.emailSearch.domainSearch({
      domain: "stripe.com",
      limit: 99999,
    }),
  );

  if (!RUN_PAID) {
    record(m, "paid happy-path", "SKIP", "RUN_PAID not set");
    record(m, "charge-on-reject", "SKIP", "RUN_PAID not set");
    return;
  }
  try {
    const out = await sapiom.search.emailSearch.domainSearch({
      domain: "stripe.com",
      limit: 3,
    });
    const ok =
      out && typeof out.domain === "string" && Array.isArray(out.emails);
    record(
      m,
      "paid happy-path shape",
      ok ? "PASS" : "FAIL",
      ok ? `emails=${out.emails.length}` : "missing domain/emails",
    );
    const leak = findLeak(out);
    record(m, "no provider/servedBy leak", leak ? "FAIL" : "PASS", leak || "");
  } catch (err) {
    record(m, "paid happy-path shape", "FAIL", err.message);
  }
  await chargeOnReject(m, () =>
    sapiom.search.emailSearch.domainSearch({
      domain: "stripe.com",
      limit: 99999,
    }),
  );
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

console.log("\n=== search E2E ===\n");
await runScrape();
await runWebSearch();
await runFindEmail();
await runVerifyEmail();
await runDomainSearch();

// Summary.
const fails = rows.filter((r) => r.status === "FAIL");
const passes = rows.filter((r) => r.status === "PASS");
const skips = rows.filter((r) => r.status === "SKIP");
console.log("\n=== summary ===");
console.log(
  `PASS: ${passes.length}  FAIL: ${fails.length}  SKIP: ${skips.length}`,
);
if (fails.length) {
  console.log("\nFAILURES:");
  for (const f of fails)
    console.log(`  - ${f.method} :: ${f.check} (${f.detail})`);
}
process.exit(fails.length ? 1 : 0);
