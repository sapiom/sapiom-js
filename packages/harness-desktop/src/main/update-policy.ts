/**
 * Update policy — the decisions about WHICH build an install follows and WHETHER
 * it checks at all. Deliberately pure: no `electron`, no `electron-updater`.
 *
 * That split is required, not stylistic. `vitest.config.ts` unit-tests only the
 * main-process modules that don't import `electron`, on the stated grounds that
 * mocking it would re-assert the same assumptions the packaged `--smoke` run
 * exists to check. These two functions are exactly the parts that can be wrong
 * *silently* — a mis-resolved channel doesn't crash, it just quietly ships the
 * wrong build to the wrong people — so they belong on the testable side of that
 * line. The `electron`-facing wiring lives in `updater.ts`.
 */

export type UpdateChannel = "latest" | "beta";

export interface ChannelDecision {
  /** The channel file the updater reads: `latest*.yml` or `beta*.yml`. */
  channel: UpdateChannel;
  /**
   * Whether pre-release GitHub Releases are considered at all. The GitHub
   * provider filters pre-releases out of the release feed *before* looking for a
   * channel file, so a beta install needs this on or it never sees the beta
   * release the channel name points at.
   */
  allowPrerelease: boolean;
  /**
   * Set when SAPIOM_UPDATE_CHANNEL held something unusable, so the caller can
   * warn. A silently-ignored override is a support trap: the user believes they
   * switched channels and nothing happens, with no evidence either way.
   */
  ignoredOverride?: string;
}

/**
 * The one genuinely discretionary knob. False means a stable install is NEVER
 * offered a pre-release — the safe default, since pre-release is precisely the
 * build nobody has validated yet.
 *
 * Flip it to true only if you want "ship the fix to everyone immediately" to be
 * the standing behaviour rather than a deliberate act. Note there is already a
 * per-machine escape hatch that doesn't require this: SAPIOM_UPDATE_CHANNEL=beta
 * moves one install onto betas without changing policy for everybody.
 */
export const STABLE_ACCEPTS_PRERELEASE = false;

/** Env var a tester (or a dev) sets to follow a different channel. */
export const CHANNEL_ENV_VAR = "SAPIOM_UPDATE_CHANNEL";
/** Env var that turns update checking off entirely. */
export const DISABLE_ENV_VAR = "SAPIOM_DISABLE_UPDATER";
/**
 * Env var that runs the updater against a hand-written `dev-app-update.yml` from
 * an unpackaged build. Without it the dev loop for this feature is "cut a tag and
 * wait for CI", which is not a loop.
 */
export const FORCE_ENV_VAR = "SAPIOM_FORCE_UPDATER";

const CHANNELS: readonly UpdateChannel[] = ["latest", "beta"];

/**
 * The slice of the persisted update preferences that affects channel choice.
 *
 * Structural rather than importing `UpdatePrefs` from update-prefs.ts: this module
 * is the pure policy layer and gains nothing from knowing about the prefs file's
 * shape, its skip list, or its IO.
 */
export interface UpdateChannelPrefs {
  /** The user opted this install into pre-release builds. */
  preRelease: boolean;
}

/**
 * True when the version carries a semver pre-release component (`0.1.2-beta.1`),
 * which is how a beta artifact is distinguished from a final one.
 *
 * Build metadata is stripped first: `0.1.2+ci.44` is a *final* release, and the
 * `-` inside a build tag like `0.1.2+pr-44` would otherwise read as one.
 *
 * Hand-rolled rather than importing `semver`: it isn't a declared dependency of
 * this package (only a transitive one of electron-updater), and relying on a
 * transitive dep is how a working build breaks on an unrelated upgrade.
 */
function hasPrereleaseTag(version: string): boolean {
  const [core = ""] = version.trim().split("+", 1);
  return /^\d+\.\d+\.\d+-\S/.test(core);
}

/**
 * Which channel this install follows.
 *
 * The version is the source of truth, because it is the one thing that is
 * unambiguously baked into the artifact the user is actually running: a build
 * tagged `-beta.N` follows betas, a final build follows finals. We cannot let
 * electron-builder infer this — `detectUpdateChannel` is documented as not
 * applying to GitHub publishing — so the app decides for itself.
 *
 * Channels are a hierarchy, not a partition: a beta install accepts betas AND
 * newer finals, so a tester is pulled back onto the stable line as soon as one
 * ships rather than being stranded on a branch nobody publishes to any more.
 * (The release job's `latest*.yml` → `beta*.yml` copy is the other half of that;
 * without it the beta channel file simply vanishes at the next final release.)
 *
 * The env override is honoured even in a packaged build, on purpose. It is the
 * only way to say "put this one machine on betas" before there is any settings
 * UI — a tester who hits a bug we already fixed can get the fix today, and it
 * costs a restart with an env var rather than a release.
 */
export function resolveUpdateChannel(
  version: string,
  env: NodeJS.ProcessEnv,
  prefs?: UpdateChannelPrefs,
): ChannelDecision {
  const fromVersion: UpdateChannel = hasPrereleaseTag(version) ? "beta" : "latest";

  const raw = env[CHANNEL_ENV_VAR];
  const requested = raw?.trim().toLowerCase();
  const override = CHANNELS.find((c) => c === requested);

  // The persisted opt-in can only move an install ONTO betas, never off them: a
  // build that is itself a pre-release follows betas whatever the toggle says,
  // because the alternative is offering `latest` to a machine running `-beta.2`
  // and calling a downgrade an update.
  const fromPrefs: UpdateChannel | undefined = prefs?.preRelease ? "beta" : undefined;

  // Env beats the toggle beats the version. The env var stays the top of the
  // chain deliberately — it is the one-off debugging escape hatch, and someone
  // who exported it is asking a more specific question than the stored setting.
  const channel = override ?? fromPrefs ?? fromVersion;
  const decision: ChannelDecision = {
    channel,
    // A beta install must accept pre-releases or the channel name is inert.
    allowPrerelease: channel !== "latest" || STABLE_ACCEPTS_PRERELEASE,
  };

  // Something was set but wasn't a channel — report it rather than swallow it.
  if (raw !== undefined && raw.trim() !== "" && !override) {
    decision.ignoredOverride = raw;
  }
  return decision;
}

export interface UpdaterGateInput {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `--dev` was passed. */
  devMode: boolean;
  /** `--smoke` was passed. */
  smoke: boolean;
  env: NodeJS.ProcessEnv;
}

export interface UpdaterGate {
  enabled: boolean;
  /** Why it's off, for the log. Absent when enabled. */
  reason?: string;
  /**
   * Enabled only because of the force override, so the caller must also set
   * `autoUpdater.forceDevUpdateConfig` — otherwise electron-updater looks for the
   * `app-update.yml` that only packaging writes and throws instead of reading the
   * `dev-app-update.yml` the developer just wrote.
   */
  forced?: boolean;
}

/**
 * Whether to run update checks at all.
 *
 * Each exclusion is load-bearing:
 *  - **unpackaged**: electron-updater throws without the `app-update.yml` that
 *    only packaging writes, so a dev run would surface a boot error for nothing.
 *  - **smoke**: a CI smoke run must not reach out to GitHub. It would make the
 *    packaging gate depend on network + the state of our releases, turning a
 *    deterministic check into a flaky one.
 *  - **dev**: same as unpackaged in practice, but explicit, so `--dev` against a
 *    packaged build (which happens) is also quiet.
 *  - **env opt-out**: the answer to "how do I stop it phoning home", asked once
 *    per privacy-conscious user, and useful when bisecting a boot problem.
 *
 * Order is deliberate. The opt-out wins over everything, including the force
 * override, because a user who asked for no update traffic must get none whatever
 * else is set. `smoke` is checked BEFORE the force override so no combination of
 * env vars can make the packaging gate hit the network — the force override is a
 * developer convenience, and CI hermeticity outranks it.
 */
export function shouldEnableUpdater(input: UpdaterGateInput): UpdaterGate {
  if (input.env[DISABLE_ENV_VAR] === "1") return { enabled: false, reason: `${DISABLE_ENV_VAR}=1` };
  if (input.smoke) return { enabled: false, reason: "smoke run" };
  if (input.env[FORCE_ENV_VAR] === "1") return { enabled: true, forced: true };
  if (!input.isPackaged) return { enabled: false, reason: "not a packaged build" };
  if (input.devMode) return { enabled: false, reason: "--dev" };
  return { enabled: true };
}

/** What went wrong with a check, in terms a user can act on. */
export type UpdateErrorKind =
  /** The channel has no release to offer — not a fault, just nothing published. */
  | "no-release"
  /** We could not reach GitHub. */
  | "offline"
  /** GitHub answered 429 — throttled, self-clearing; retrying now makes it worse. */
  | "rate-limited"
  /**
   * Something on this network answered in place of GitHub: a proxy, a captive
   * portal, or a sign-on gate. Retrying changes nothing; the user has to sort
   * out their access to github.com.
   */
  | "intercepted"
  | "other";

/** An HTML document anywhere in the message: an error body, or where the Atom feed should be. */
const HTML_DOCUMENT = /<!doctype\s+html|<html[\s>]|<\/html>/i;

/**
 * The response facts electron-updater leaves in its error message.
 *
 * builder-util-runtime formats every HTTP failure as
 * `${status} ${statusMessage}\n<JSON description>\nHeaders: <JSON headers>`, and
 * GitHubProvider embeds that text when it rewraps a `/releases/latest` failure,
 * so the headers are already in the string we get.
 */
interface UpdateHttpEvidence {
  /** From the error head only (start of a line, or after `HttpError:`) — never from a URL. */
  status?: number;
  server?: string;
  contentType?: string;
  /** A `Headers: {…}` blob is present at all. */
  hasHeaders: boolean;
  /** GitHub signed it: `x-github-request-id`, or `server: github.com` exactly. */
  fromGitHub: boolean;
  /** `retry-after` or any `x-ratelimit-*` header. */
  throttled: boolean;
}

function readHttpEvidence(head: string): UpdateHttpEvidence {
  const status = /(?:^|HttpError:\s*)(\d{3})(?=\s|$)/m.exec(head);
  const at = head.search(/Headers:\s*\{/);
  const headers = at < 0 ? "" : head.slice(at);
  const header = (name: string): string | undefined => new RegExp(`"${name}":\\s*"([^"]*)"`, "i").exec(headers)?.[1];
  const server = header("server");
  return {
    status: status ? Number(status[1]) : undefined,
    server,
    contentType: header("content-type"),
    hasHeaders: at >= 0,
    fromGitHub: header("x-github-request-id") !== undefined || server?.trim().toLowerCase() === "github.com",
    throttled: header("retry-after") !== undefined || /"x-ratelimit-[a-z-]*":/i.test(headers),
  };
}

/**
 * Turn electron-updater's error into one short, human line.
 *
 * This exists because the raw message is unusable in a UI: for a channel with no
 * published release, GitHubProvider appends the **entire releases Atom feed** plus
 * a full stack trace, so `error.message` is kilobytes of XML. Rendering that in a
 * toast is what happens if you trust it (it did).
 *
 * Also separates "nothing is published yet" from "something broke". The first is a
 * normal state — a stable install correctly ignores pre-releases, so before the
 * first final release there is genuinely nothing to find — and calling it an error
 * teaches users to distrust the feature.
 *
 * `detail` is for the log only: `status=403 server=corp-proxy content-type=text/html`,
 * nothing else (no body, no cookies, no redirect URL), so a screenshot of the log
 * settles "GitHub or the network?" without leaking anything.
 */
export function classifyUpdateError(raw: string): { kind: UpdateErrorKind; summary: string; detail?: string } {
  // Cut the appended feed first: everything from `, XML:` on is the Atom document.
  const withoutXml = raw.split(/,\s*XML:/)[0] ?? raw;
  // Then the first line, because the rest is a stack trace.
  const firstLine = (withoutXml.split(/\r?\n/)[0] ?? "").trim();
  const collapsed = firstLine.replace(/\s+/g, " ");
  const evidence = readHttpEvidence(withoutXml);
  const detail =
    [
      evidence.status !== undefined ? `status=${evidence.status}` : "",
      evidence.server ? `server=${evidence.server}` : "",
      evidence.contentType ? `content-type=${evidence.contentType}` : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  // A response GitHub did not send, decided first: read by status alone a proxy's
  // 429 toasts as "rate-limited" (it never clears), its 403 as jargon, and its
  // sign-in page in place of the feed as "no release published yet".
  if (isIntercepted(raw, evidence)) {
    return {
      kind: "intercepted",
      summary: "github.com isn't reachable from this network. Check that you can open github.com, then try again.",
      detail,
    };
  }

  // 429 next — ahead of both no-release and net::ERR. A 429 is GitHub
  // answering, not unreachable (so it must not take the offline branch, whose
  // caller retries immediately). More subtly, it must not take the no-release
  // branch either: electron-updater's GitHubProvider wraps ANY failure of its
  // `/releases/latest` request as "Unable to find latest version on GitHub …
  // please ensure a production release exists: HttpError: 429 Too Many
  // Requests", so testing no-release first told a throttled user "nothing is
  // published yet" — the one message that invites them to click again, when
  // clicking is exactly what deepens the limit.
  // A 403 carrying throttle headers is GitHub's secondary rate limit.
  if (evidence.status === 429 || /too many requests/i.test(collapsed) || (evidence.status === 403 && evidence.throttled)) {
    return {
      kind: "rate-limited",
      summary: "GitHub is rate-limiting this network — it clears on its own; try again in a while",
      detail,
    };
  }
  if (/unable to find latest version|ensure a production release exists|no published versions/i.test(collapsed)) {
    return { kind: "no-release", summary: "no release has been published on this channel yet", detail };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR/i.test(collapsed)) {
    return { kind: "offline", summary: "could not reach GitHub", detail };
  }
  // Unknown: keep it, but bounded. A truncated real message still beats a generic
  // one when someone has to diagnose it from a screenshot.
  const MAX = 160;
  const summary = collapsed.length > MAX ? `${collapsed.slice(0, MAX - 1).trimEnd()}…` : collapsed;
  return { kind: "other", summary: summary || "the update check failed", detail };
}

/** `raw` is the whole message, because the HTML may be the appended "feed". */
function isIntercepted(raw: string, evidence: UpdateHttpEvidence): boolean {
  // Anything GitHub itself signed is GitHub's answer, whatever it says; and a
  // throttled 403/429 is a throttle whoever sent it ("wait, then retry" is right).
  // 401/407 are challenges, and a retry-after does not make them a rate limit.
  if (evidence.fromGitHub || (evidence.throttled && (evidence.status === 403 || evidence.status === 429))) return false;
  // GitHub does not challenge anonymous reads of a public repo's releases, and
  // 407 has exactly one issuer: a proxy demanding credentials.
  if (evidence.status === 401 || evidence.status === 403 || evidence.status === 407) return true;
  // A 429 whose headers we can see, naming neither GitHub nor a throttle. A 429
  // with no headers blob at all stays a rate limit — there is nothing to say otherwise.
  if (evidence.status === 429 && evidence.hasHeaders) return true;
  // A page meant for a browser, which GitHub's release endpoints never send us.
  return HTML_DOCUMENT.test(raw);
}
