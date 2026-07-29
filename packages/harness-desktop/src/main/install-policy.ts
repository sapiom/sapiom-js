/**
 * Whether to install the `sapiom` CLI on this launch.
 *
 * Why the app installs it at all: three macro prompts (`harness/src/core/macros.ts`)
 * and the templates door (`harness/web/src/lib/templates.ts`) hand the coding
 * agent commands like `sapiom agents deploy` and `sapiom agents init . -t <id>`.
 * Nothing shipped that binary — `installClaudeCode()` installs the *agent* only,
 * and `runDoctor()` never checked for it — so on a machine without a global
 * install the agent got `command not found` and improvised. That reads as "the
 * app is broken in a strange way" rather than "a dependency is missing".
 *
 * (The direct in-app Deploy / Local Run buttons never needed the CLI: they call
 * agent-core in-process or via the bootstrap child. Only the agent-driven doors
 * shell out to it.)
 *
 * Pure so the three refusals are pinned by tests, because each one is a bug we
 * would otherwise ship: installing when the user already has their own copy
 * (hijacking it), installing during `--smoke` (making CI depend on the network,
 * which `harness-desktop/CLAUDE.md` forbids), and installing on every launch
 * (a network round-trip in the boot path).
 */

/**
 * The published package, dist-tagged for the same reason the generated MCP config
 * pins `@sapiom/mcp@latest`: a bare name resolves a LOCAL workspace copy when the
 * app runs from inside the monorepo, whose bin is not linked.
 */
export const SAPIOM_CLI_PACKAGE = "@sapiom/cli@latest";

export interface SapiomCliDecision {
  install: boolean;
  /** Human-readable, and logged either way — a silent skip is how this class of
   *  gap stayed invisible in the first place. */
  reason: string;
}

export function shouldInstallSapiomCli(input: {
  /** Absolute path if `sapiom` already resolves on PATH, else null. PATH already
   *  includes the app's own npm prefix at this point, so a previous launch's
   *  install lands here — that is what makes this one-shot. */
  onPath: string | null;
  smoke: boolean;
  devMode: boolean;
}): SapiomCliDecision {
  if (input.onPath) {
    return { install: false, reason: `already on PATH at ${input.onPath}` };
  }
  if (input.smoke) {
    return { install: false, reason: "skipped in --smoke (CI must not depend on the network)" };
  }
  if (input.devMode) {
    return { install: false, reason: "skipped in dev (use the workspace CLI)" };
  }
  return { install: true, reason: "sapiom is not on PATH" };
}
