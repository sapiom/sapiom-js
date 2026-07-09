/**
 * HarnessAdapter union type — the shape every adapter (embedded or external)
 * must satisfy.
 *
 * "embedded" adapters are spawned inside a pty session by the harness.
 * "external" adapters run in their own companion app and have no spawn path —
 * the type makes calling spawn/send on them a compile error, not just a
 * convention.
 *
 * Adding an external harness = one descriptor file + one HARNESS_ADAPTER_INFOS
 * line. An embedded harness that can be spawned as a session additionally
 * requires: a runtime adapter (launch/resume/doctor/listPastSessions) in
 * core/adapters/, a new id in SPAWNABLE_HARNESS_KINDS (shared/types.ts —
 * which widens HarnessKind and the z.enum gate automatically), and a real
 * e2e suite confirming the lifecycle works end-to-end.
 */

/** Stable identifier for every harness the registry knows about. */
export type HarnessAdapterId =
  | "claude-code"
  | "codex"
  | "pi"
  | "opencode"
  | "conductor";

/** Whether the harness is spawned by the harness (embedded) or managed by its
 *  own companion app (external). */
export type HarnessAdapterMode = "embedded" | "external";

/** Fields shared by every adapter regardless of mode. */
export interface HarnessAdapterBase {
  /** Stable identifier used in APIs and the session registry. */
  id: HarnessAdapterId;
  /** Human-readable name for pickers and logs. */
  label: string;
  /** Spawn mode — narrow on this before calling any spawn-path methods. */
  mode: HarnessAdapterMode;
  /**
   * Per-agent prompt text guiding the user through installing and
   * configuring the Sapiom MCP server (`@sapiom/mcp`) for this harness.
   * Consumed by the skills-panel Install MCP modal. Returns the text string
   * directly — callers may render it as preformatted text.
   */
  installMcpPrompt(): string;
  /**
   * Best-effort detection of whether the harness is installed on this
   * machine. Never throws.
   */
  detectInstalled(): Promise<boolean>;
  /**
   * Marks adapters whose launch behavior is best-effort and not yet
   * hardened by an end-to-end suite. Absent (or false) for fully
   * supported harnesses.
   */
  experimental?: boolean;
}

/**
 * An adapter the harness spawns inside a pty session.
 * The existing `HarnessAdapter` interface (shared/types.ts) carries the actual
 * launch/resume/doctor/listPastSessions contract consumed by SessionManager;
 * this is the registry-level description used for enumeration and the
 * harnesses listing endpoint.
 */
export interface EmbeddedHarnessAdapterInfo extends HarnessAdapterBase {
  mode: "embedded";
}

/**
 * An adapter for a harness that runs in its own companion app.
 * There is deliberately no spawn path — `launchCommand` is absent so a
 * spawn attempt is a compile error rather than a runtime surprise.
 */
export interface ExternalHarnessAdapterInfo extends HarnessAdapterBase {
  mode: "external";
}

/**
 * Every registry entry satisfies this union. Narrow on `mode` before
 * attempting any spawn-path operation — external adapters have none.
 */
export type HarnessAdapterInfo = EmbeddedHarnessAdapterInfo | ExternalHarnessAdapterInfo;
