import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { z } from "zod/v4";

/**
 * Logged-In Page Screenshots — open a real browser, optionally log in, visit the
 * pages you list, and capture each one as a hosted image.
 *
 * A plain scraper can't see a page that lives behind a login, and it never sees
 * what the page actually LOOKS like. This drives a real hosted browser
 * (`ctx.sapiom.browserAutomation`), so it can sign in with credentials you supply
 * and capture the rendered page — the exact view a logged-in user gets. Use it to
 * archive a dashboard, verify a deploy renders right, or keep a visual record of a
 * page behind auth.
 *
 * The graph, one legible line per capability:
 *   start ─▶ login (browser.identity) ─▶ capture (browser.session) ─▶ done
 *   start ─────────────────────────────▶ capture (browser.session) ─▶ done
 *
 * One browser session captures EVERY page in a single sitting. In-session
 * screenshots carry no per-shot charge — billing settles once when the session
 * closes — so visiting five pages costs one session, not five one-shots. The
 * session is always closed in a `finally` (that is what `withSession` guarantees),
 * so it can never leak at the ceiling charge.
 *
 * Never-fail discipline:
 *   - Runs with nothing: no login, it captures a couple of stable public pages and
 *     returns their image URLs. `authenticated` is honestly `false`.
 *   - Login is optional and degrades honestly. Ask for a login without setting the
 *     password secret, or let identity creation fail, and it captures the PUBLIC
 *     view and reports `authenticated: false` with a reason — it never claims a
 *     logged-in capture it didn't make.
 *   - Every requested URL yields a row whether its shot succeeded or not, so one
 *     unreachable page never sinks the run and the result is always a full account.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Cap how many pages one session captures, to bound session time and cost. */
const MAX_URLS = 8;
/**
 * The pages a zero-input run captures. Both are IANA reserved example domains —
 * about the most stable public pages there are — so the default run always has
 * something real to shoot.
 */
const DEFAULT_URLS = ["https://example.com", "https://example.org"];

/** The env var the login password is read from (never an input field). */
const PASSWORD_ENV = "BROWSER_LOGIN_PASSWORD";

// ─────────────────────────────────────────────────────────────── shapes ──
interface EntryInput {
  /** The pages to capture. Defaults to two stable public pages. */
  urls?: string[];
  /**
   * The login page URL. Set it (with `loginUsername` and the `BROWSER_LOGIN_PASSWORD`
   * secret) to capture pages behind a login. Omit for public capture.
   */
  loginUrl?: string;
  /** The username to log in with. Paired with the `BROWSER_LOGIN_PASSWORD` secret. */
  loginUsername?: string;
  /** Capture the full scrollable page height instead of just the viewport. */
  fullPage?: boolean;
}

/** One captured page — always present per requested URL, success or not. */
interface Shot {
  url: string;
  /** Hosted image URL, or null when the capture failed. */
  imageUrl: string | null;
  /** ISO-8601 expiry of the hosted image, when captured. */
  expiresAt: string | null;
  ok: boolean;
  /** A short reason when the capture failed. */
  error: string | null;
}

interface Shared extends Record<string, unknown> {
  urlCount: number;
  fullPage: boolean;
  /** Whether the session ran with a logged-in identity. */
  authenticated: boolean;
  /** Why a run isn't authenticated, when a login was expected. */
  note?: string;
}

type Ctx = AgentExecutionContext<Shared>;

/** The payload carried from `start`/`login` into `capture`. */
interface CapturePlan {
  urls: string[];
  /** The identity to open the session with, or null for a public session. */
  identityId: string | null;
  fullPage: boolean;
}

// ─────────────────────────────────────────────────────────────── helpers ──
/** Trim, drop non-http(s), de-dupe, and cap — the pages a run will capture. */
function normalizeUrls(urls: unknown, fallback: string[]): string[] {
  const cleaned = Array.isArray(urls)
    ? [
        ...new Set(
          urls
            .filter((u): u is string => typeof u === "string")
            .map((u) => u.trim())
            .filter((u) => /^https?:\/\//i.test(u)),
        ),
      ]
    : [];
  const chosen = cleaned.length > 0 ? cleaned : fallback;
  return chosen.slice(0, MAX_URLS);
}

/** A row for a page that was never shot (session never opened). */
function missedShot(url: string, error: string): Shot {
  return { url, imageUrl: null, expiresAt: null, ok: false, error };
}

// ─────────────────────────────────────────────────────────────── steps ──
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. `urls` defaults to two stable
 * public pages so a zero-input run captures something real; the login fields
 * stay optional (public capture when omitted).
 */
const entryInput = z.object({
  urls: z
    .array(z.string())
    .default(DEFAULT_URLS)
    .describe("The pages to capture."),
  loginUrl: z
    .string()
    .optional()
    .describe(
      "Login page URL — set it with loginUsername and the BROWSER_LOGIN_PASSWORD secret to capture behind a login.",
    ),
  loginUsername: z
    .string()
    .optional()
    .describe(
      "Username to log in with, paired with the BROWSER_LOGIN_PASSWORD secret.",
    ),
  fullPage: z
    .boolean()
    .default(false)
    .describe(
      "Capture the full scrollable page height instead of just the viewport.",
    ),
});

const start = defineStep({
  name: "start",
  inputSchema: entryInput,
  next: ["login", "capture"],
  async run(input: EntryInput, ctx: Ctx) {
    const urls = normalizeUrls(input.urls, DEFAULT_URLS);
    const fullPage = input.fullPage === true;
    ctx.shared.set("urlCount", urls.length);
    ctx.shared.set("fullPage", fullPage);
    ctx.shared.set("authenticated", false);

    const loginUrl = input.loginUrl?.trim() || "";
    const username = input.loginUsername?.trim() || "";
    const password = (process.env[PASSWORD_ENV] ?? "").trim();

    // No login asked for — capture the public view.
    if (!loginUrl && !username) {
      return goto("capture", { urls, identityId: null, fullPage });
    }

    // Login asked for but under-configured — capture public, say what was missing.
    const missing: string[] = [];
    if (!loginUrl) missing.push("loginUrl");
    if (!username) missing.push("loginUsername");
    if (!password) missing.push(`${PASSWORD_ENV} secret`);
    if (missing.length > 0) {
      ctx.shared.set(
        "note",
        `Captured the public view — login needs ${missing.join(", ")}. Set them to capture behind the login.`,
      );
      ctx.logger.info("login under-configured; capturing public view", {
        missing,
      });
      return goto("capture", { urls, identityId: null, fullPage });
    }

    // Route with a flag, not the secret: the password is re-read from env in the
    // `login` step so it never rides in a persisted step transition.
    return goto("login", { urls, loginUrl, username, fullPage });
  },
});

const login = defineStep({
  name: "login",
  next: ["capture"],
  async run(
    input: {
      urls: string[];
      loginUrl: string;
      username: string;
      fullPage: boolean;
    },
    ctx: Ctx,
  ) {
    // Re-read the password from the injected env at the point of use rather than
    // carrying it in the step transition: a step's input is persisted in the durable
    // agent-run record, and a login secret must never land there. The secret is
    // injected into every step's env, so reading it here keeps it out of the trace.
    const password = (process.env[PASSWORD_ENV] ?? "").trim();
    if (!password) {
      // Shouldn't happen — `start` only routes here when the secret was present —
      // but if the env changed under us, degrade to a public capture rather than
      // sending an empty credential.
      ctx.shared.set(
        "note",
        `Captured the public view — the ${PASSWORD_ENV} secret was not set.`,
      );
      ctx.logger.info("password secret absent at login; capturing public view");
      return goto("capture", {
        urls: input.urls,
        identityId: null,
        fullPage: input.fullPage,
      });
    }

    // Store the credentials as a browser identity; the session opens pre-logged-in.
    // Creating an identity is free. If it fails, degrade to a public capture rather
    // than failing the run — a public shot beats no shot.
    try {
      const identity = await ctx.sapiom.browserAutomation.identities.create({
        source: input.loginUrl,
        name: "logged-in-screenshots",
        credentials: [
          {
            type: "username_password",
            username: input.username,
            password,
          },
        ],
      });
      ctx.logger.info("created login identity", { identityId: identity.id });
      return goto("capture", {
        urls: input.urls,
        identityId: identity.id,
        fullPage: input.fullPage,
      });
    } catch (err) {
      ctx.shared.set(
        "note",
        "Captured the public view — the login identity could not be created.",
      );
      ctx.logger.warn("identity creation failed; capturing public view", {
        err: String(err),
      });
      return goto("capture", {
        urls: input.urls,
        identityId: null,
        fullPage: input.fullPage,
      });
    }
  },
});

const capture = defineStep({
  name: "capture",
  next: ["done"],
  async run(input: CapturePlan, ctx: Ctx) {
    const { urls, identityId, fullPage } = input;
    const authenticated = identityId !== null;
    ctx.shared.set("authenticated", authenticated);

    ctx.logger.info("opening browser session", {
      pages: urls.length,
      authenticated,
    });

    let shots: Shot[];
    try {
      // One session, every page. `withSession` always closes in a `finally`, so
      // the session settles even if a capture throws.
      shots = await ctx.sapiom.browserAutomation.withSession(
        async (session) => {
          const out: Shot[] = [];
          for (const url of urls) {
            try {
              const shot = await session.screenshot({ url, fullPage });
              out.push({
                url,
                imageUrl: shot.url,
                expiresAt: shot.expiresAt ?? null,
                ok: true,
                error: null,
              });
            } catch (err) {
              // A single unreachable page degrades to a failed row; the session
              // stays open and the remaining pages are still captured.
              ctx.logger.warn("page capture failed", { url, err: String(err) });
              out.push(missedShot(url, String(err)));
            }
          }
          return out;
        },
        identityId ? { identityId } : undefined,
      );
    } catch (err) {
      // The session itself could not open — record every requested page as missed
      // so the run still terminates with a complete, honest account.
      ctx.logger.error("browser session failed to open", { err: String(err) });
      shots = urls.map((url) => missedShot(url, String(err)));
    }

    return goto("done", { shots });
  },
});

const done = defineStep({
  name: "done",
  next: [],
  terminal: true,
  async run(input: { shots: Shot[] }, ctx: Ctx) {
    const shots = input.shots ?? [];
    const captured = shots.filter((s) => s.ok).length;
    return terminate({
      authenticated: ctx.shared.get("authenticated") ?? false,
      requested: shots.length,
      captured,
      screenshots: shots,
      note: ctx.shared.get("note"),
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "logged-in-screenshots",
  entry: "start",
  steps: {
    start,
    login,
    capture,
    done,
  },
});
