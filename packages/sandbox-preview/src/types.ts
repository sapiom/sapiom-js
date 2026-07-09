/**
 * Public contract for the sandbox-preview client flow. Provider-neutral: the
 * deploy recipe itself lives server-side (the `previews` capability); this layer
 * only reads intent, provisions the sandbox, uploads, and calls the server op.
 */

/** Where the app's code comes from. `upload` (local fs) is supported now; `git` is a later phase. */
export type SandboxSourceSpec =
  | { kind: 'upload'; path?: string }
  | { kind: 'git'; slug: string; path?: string };

/** Declared intent for one sandbox-preview resource (`sapiom.json`, `type: "sandbox"`). */
export interface SandboxConfig {
  /** Local resource handle (the `resources` map key) — also the sandbox name. */
  name: string;
  /** Where the code comes from. */
  source: SandboxSourceSpec;
  /** Build command (e.g. `npm install`). Skipped if omitted. */
  build?: string;
  /** Command that starts the long-running server. */
  start: string;
  /** Port the app listens on — exposed publicly. */
  port: number;
  /** Memory tier for the sandbox (xs|s|m|l|xl). */
  tier?: string;
  /** Time-to-live (e.g. `24h`, `7d`). */
  ttl?: string;
  /** Extra environment variables injected into the app process. */
  env?: Record<string, string>;
}

/** Result of a preview deploy. */
export interface PreviewResult {
  /** The sandbox / resource name. */
  name: string;
  /** The public URL serving the app. Null when the deploy failed before exposure. */
  url: string | null;
  /** Deploy outcome: `deployed`, `unverified`, or `failed`. */
  status: string;
  /** Build/start log output (tail); populated especially on failure. */
  logs: string;
}
