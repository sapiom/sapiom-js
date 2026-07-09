/**
 * Public contract for the sandbox-preview client flow. Provider-neutral: the
 * deploy recipe itself lives server-side (the `previews` capability); this layer
 * only reads intent, provisions the sandbox, uploads, and calls the server op.
 *
 * The declared-intent shapes below are derived from the zod schema (schema.ts) —
 * the single source of truth — so the config validator and these types never drift.
 */
import type { SandboxConfigBody } from './schema.js';

/** Where the app's code comes from. `upload` (local fs) is supported now; `git` is a later phase. */
export type SandboxSourceSpec = SandboxConfigBody['source'];

/**
 * Declared intent for one sandbox-preview resource (`sapiom.json`, `type: "sandbox"`).
 * The `name` is the `resources` map key (also the sandbox name); the rest is the
 * validated resource body (source, build?, start, port, tier?, ttl?, env?).
 */
export type SandboxConfig = { name: string } & SandboxConfigBody;

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
