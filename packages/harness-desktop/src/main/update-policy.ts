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
export function resolveUpdateChannel(version: string, env: NodeJS.ProcessEnv): ChannelDecision {
  const fromVersion: UpdateChannel = hasPrereleaseTag(version) ? "beta" : "latest";

  const raw = env[CHANNEL_ENV_VAR];
  const requested = raw?.trim().toLowerCase();
  const override = CHANNELS.find((c) => c === requested);

  const channel = override ?? fromVersion;
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
  | "other";

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
 */
export function classifyUpdateError(raw: string): { kind: UpdateErrorKind; summary: string } {
  // Cut the appended feed first: everything from `, XML:` on is the Atom document.
  const withoutXml = raw.split(/,\s*XML:/)[0] ?? raw;
  // Then the first line, because the rest is a stack trace.
  const firstLine = (withoutXml.split(/\r?\n/)[0] ?? "").trim();
  const collapsed = firstLine.replace(/\s+/g, " ");

  if (/unable to find latest version|ensure a production release exists|no published versions/i.test(collapsed)) {
    return { kind: "no-release", summary: "no release has been published on this channel yet" };
  }
  // Before the net::ERR bucket: a 429 is GitHub answering, not unreachable.
  // Seen live after a day of repeated installs/boot-checks from one home IP —
  // it clears on its own, and the message should say so rather than leak
  // HTTP jargon into a toast (or invite a retry storm via the offline path).
  if (/\b429\b|too many requests/i.test(collapsed)) {
    return {
      kind: "rate-limited",
      summary: "GitHub is rate-limiting this network — it clears on its own; try again in a while",
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR/i.test(collapsed)) {
    return { kind: "offline", summary: "could not reach GitHub" };
  }
  // Unknown: keep it, but bounded. A truncated real message still beats a generic
  // one when someone has to diagnose it from a screenshot.
  const MAX = 160;
  const summary = collapsed.length > MAX ? `${collapsed.slice(0, MAX - 1).trimEnd()}…` : collapsed;
  return { kind: "other", summary: summary || "the update check failed" };
}
