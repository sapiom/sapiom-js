/**
 * The harness adapter contract.
 *
 * A "harness" is a coding agent app (Claude Code, Codex CLI, …) that the
 * Sapiom harness can launch, detect, or guide the user through configuring.
 * Each supported harness ships as one adapter file registered in
 * `./index.ts`; adding a harness is one adapter file plus one registry
 * line.
 */

/** Identifier of a harness the registry knows about. */
export type HarnessId =
  | "claude-code"
  | "codex"
  | "pi"
  | "opencode"
  | "conductor";

/**
 * How a harness runs:
 *
 * - `embedded` — spawned and owned by the harness inside a pty session
 *   (`SessionRuntime`).
 * - `external` — runs in its own app outside our process. The adapter
 *   offers detection and setup guidance only; it has no spawn path.
 */
export type HarnessMode = "embedded" | "external";

/**
 * How a prompt reaches an embedded harness:
 *
 * - `inline` — passed on the command line at launch
 *   ({@link HarnessLaunchConfig.prompt}).
 * - `post-launch` — injected into the running session (a pty write) after
 *   the harness has booted.
 */
export type PromptDelivery = "inline" | "post-launch";

/** Inputs an adapter uses to compute its launch invocation. */
export interface HarnessLaunchConfig {
  /**
   * Full environment for the child session — not merged with
   * `process.env`, mirroring `SessionRuntime.create()`. Adapters copy it
   * through, adding harness-specific variables when needed.
   */
  env: Record<string, string>;
  /**
   * Initial prompt for adapters with `promptDelivery: "inline"`, included
   * in the launch arguments as a literal. Adapters with `"post-launch"`
   * delivery ignore it — deliver the prompt by writing to the session
   * once it has booted.
   */
  prompt?: string;
  /**
   * Extra system-prompt text appended to the harness's own system prompt,
   * for harnesses that support it (claude-code:
   * `--append-system-prompt`). This is the literal prompt content — if
   * yours lives in a file, read the file yourself and pass the text.
   * Sessions spawn without a shell, so the value is handed to the harness
   * verbatim as a single argument; no quoting or escaping is applied or
   * required.
   */
  appendSystemPrompt?: string;
}

/**
 * A concrete invocation, ready to spread into `SessionRuntime.create()`
 * (which adds `cwd`/`cols`/`rows`). `command` is resolved via `env.PATH`;
 * `args` are passed to the process as literals — no shell is involved at
 * any point, so nothing is interpolated, quoted, or word-split.
 */
export interface HarnessLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Fields shared by every adapter, embedded or external. */
export interface HarnessAdapterCommon {
  /** Stable identifier used in APIs and config files. */
  id: HarnessId;
  /** Human-readable name for pickers and logs. */
  label: string;
  /** See {@link HarnessMode}. */
  mode: HarnessMode;
  /**
   * See {@link PromptDelivery}. Only consulted for embedded adapters —
   * external harnesses own their prompt input entirely, so the value is
   * nominal there.
   */
  promptDelivery: PromptDelivery;
  /**
   * Marks adapters whose launch behavior is best-effort and not yet
   * hardened by an end-to-end suite. Absent (or `false`) for fully
   * supported harnesses.
   */
  experimental?: boolean;
  /**
   * Prompt text — words for the coding agent, not a script to execute —
   * guiding installation and configuration of the Sapiom MCP server
   * (npm package `@sapiom/mcp`, binary `sapiom-mcp`) for this harness.
   */
  installMcpPrompt(): string;
  /**
   * Whether the harness looks installed on this machine. Best-effort and
   * never throws.
   */
  detectInstalled(): Promise<boolean>;
}

/** An adapter the harness spawns inside a pty session. */
export interface EmbeddedHarnessAdapter extends HarnessAdapterCommon {
  mode: "embedded";
  /**
   * Compute the invocation for `SessionRuntime.create()`. Pure: no I/O,
   * no side effects, safe to call repeatedly.
   */
  launchCommand(cfg: HarnessLaunchConfig): HarnessLaunch;
}

/**
 * An adapter for a harness that runs in its own app (companion mode).
 * There is deliberately no way to spawn it: `launchCommand` is typed
 * `never`, so a spawn path is unrepresentable rather than merely
 * discouraged.
 */
export interface ExternalHarnessAdapter extends HarnessAdapterCommon {
  mode: "external";
  launchCommand?: never;
}

/**
 * Every registry entry satisfies this union. Narrow on `mode` before
 * calling `launchCommand` — it exists only for embedded adapters.
 */
export type HarnessAdapter = EmbeddedHarnessAdapter | ExternalHarnessAdapter;
