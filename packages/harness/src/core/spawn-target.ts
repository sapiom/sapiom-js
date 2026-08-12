/**
 * Windows can't spawn a bare command name, or a `.cmd` shim, the way POSIX can.
 *
 * node-pty spawns via `CreateProcess`, which — unlike a shell — does NO `PATHEXT`
 * resolution and cannot execute a `.cmd` at all. So a coding agent installed by
 * npm (which ships `claude.cmd`, not `claude.exe`) failed with
 * `Cannot create process, error code: 2` even though `doctor` found it: detection
 * shells out to `where`, which *does* resolve PATHEXT, so the agent looks present
 * and then won't start.
 *
 * ## Why this does not use `cmd.exe`
 *
 * The obvious fix — `cmd.exe /d /s /c <command> <args…>` — is a command-injection
 * hole, and a functional bug besides. node-pty quotes each argument for
 * `CreateProcess`/MSVCRT, escaping an embedded `"` as `\"`. But the immediate
 * child would be `cmd.exe`, whose tokenizer does not understand backslash-escaped
 * quotes: it toggles "inside quotes" on every literal `"` it sees. One embedded
 * quote therefore desynchronises cmd for the rest of the line, and any `&` or `|`
 * that lands in the now-unquoted span becomes a real command separator. That is
 * CVE-2024-27980's bug class, and `/s` does not address it.
 *
 * It is reachable on every session, not in a corner case: the codex adapter
 * builds `developer_instructions=${JSON.stringify(prompt)}` (JSON *always* emits
 * literal quotes) and the claude-code adapter passes raw prompt-file contents as
 * an argv element. Even ignoring injection, the quote desync mangles those values.
 *
 * So instead of escaping around a shell, we remove the shell. An npm `.cmd` shim
 * is a wrapper that ultimately runs `node <cli.js> %*`, so we read the shim,
 * recover the interpreter and script it points at, and spawn *those* directly.
 * Arguments then pass through exactly one quoting layer — node-pty's, which is
 * correct for `CreateProcess` — and no metacharacter is ever interpreted.
 *
 * Dependencies are injected so the whole Windows path is unit-testable from
 * Linux CI, which is where this class of bug hid: nothing in our test tiers ever
 * spawned a real agent on Windows.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
// The win32 namespace explicitly, NOT the host-dependent exports: `join` and
// `delimiter` resolve to POSIX rules when this runs on Linux, which silently
// broke both PATH splitting (":" vs ";") and path building ("/" vs "\\") in the
// unit tests that simulate Windows — and would have broken the real lookup for
// anyone reasoning about it from a POSIX box.
import { win32 } from "node:path";
import { SpawnTargetError } from "./errors.js";

export interface SpawnTarget {
  command: string;
  args: string[];
}

export interface SpawnTargetDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (p: string) => boolean;
  readText?: (p: string) => string;
  /** List a directory's entry names; used only to diagnose a broken shim target. */
  listDir?: (dir: string) => string[];
}

/** Executable images `CreateProcess` can launch directly, no interpreter needed. */
const DIRECTLY_EXECUTABLE = [".exe", ".com"];
/** Shims we must look inside, because Windows cannot execute them. */
const SHIM_EXTENSIONS = [".cmd", ".bat"];

function hasExtension(file: string, extensions: readonly string[]): boolean {
  const lower = file.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/**
 * Windows' own lookup rules: PATHEXT variants take precedence over a literal
 * extensionless name.
 *
 * This ordering is the whole ballgame. npm installs THREE files for a CLI —
 * `claude.cmd`, `claude.ps1`, and an extensionless `claude` (a POSIX sh script,
 * there for Git Bash). Trying the literal name first finds that sh script, which
 * Windows cannot execute and which is not a shim we can read — so we'd refuse to
 * spawn while `claude.cmd` sat right next to it. `CreateProcess` and `where`
 * both prefer PATHEXT, so we must too.
 */
function findOnPath(command: string, deps: Required<Pick<SpawnTargetDeps, "env" | "fileExists">>): string | null {
  const pathExt = (deps.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidates = (base: string): string[] => {
    const lower = base.toLowerCase();
    // Already carries an extension we know how to handle: use it as given.
    if ([...DIRECTLY_EXECUTABLE, ...SHIM_EXTENSIONS].some((ext) => lower.endsWith(ext))) return [base];
    // Otherwise PATHEXT first, the bare name only as a last resort.
    return [...pathExt.map((ext) => base + ext), base];
  };

  // An explicit path (absolute, or containing a separator) is not PATH-searched.
  if (win32.isAbsolute(command) || /[\\/]/.test(command)) {
    return candidates(command).find(deps.fileExists) ?? null;
  }
  // Windows separates PATH with ";" — always, regardless of the host we run on.
  // Entries may be quoted ("C:\\Program Files\\Foo"); cmd and `where` strip those, so
  // we must too or the directory never resolves and we report "not found" for an
  // agent `where` finds — reproducing the detect/spawn disagreement this exists to end.
  const pathEntries = (deps.env.PATH ?? deps.env.Path ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  for (const dir of pathEntries) {
    const hit = candidates(win32.join(dir, command)).find(deps.fileExists);
    if (hit) return hit;
  }
  return null;
}

/** Why a shim could not be resolved, for a targeted error message. */
interface ShimFailure {
  /**
   * The shim's quoted target does not exist, but a `<target>.old.<timestamp>`
   * sibling does — the signature Claude Code's native self-updater leaves when
   * it renames the running exe and fails to write the replacement. Names the
   * missing target so the error can say what actually happened.
   */
  staleSelfUpdate?: string;
}

type ShimResult = { target: SpawnTarget } | { target: null; failure: ShimFailure };

/**
 * Recover what an npm-generated `.cmd` shim actually runs. Its final line is of
 * the form:
 *
 *   … "%_prog%"  "%dp0%\node_modules\@scope\pkg\cli.js" %*
 *
 * so the script is the quoted `%dp0%`-relative path, and the interpreter is the
 * `node.exe` npm placed beside the shim (falling back to a real `node.exe` on
 * PATH). Returns no target when the shim isn't of that shape — we then refuse
 * to spawn rather than reaching for a shell, because a wrong guess here is a
 * security bug.
 */
function readShimTarget(
  shim: string,
  deps: Required<Pick<SpawnTargetDeps, "env" | "fileExists" | "readText" | "listDir">>,
): ShimResult {
  let contents: string;
  try {
    contents = deps.readText(shim);
  } catch {
    return { target: null, failure: {} };
  }

  const shimDir = win32.dirname(shim);

  // Structural, NOT extension-based. A shim's target is whatever it quotes on the
  // line it ends with `%*`, and that is not always a script: Claude Code ships a
  // native launcher, so its real shim reads
  //   "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
  // while a plain npm package yields "%_prog%" "%dp0%\…\cli.js" %*. Keying on
  // `.js` missed the former entirely — the mistake this now avoids by collecting
  // every quoted token and letting the filesystem decide which is real.
  const lines = contents.split(/\r?\n/);
  const quotedIn = (src: readonly string[]): string[] =>
    src.flatMap((line) => [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""));

  const candidates = [
    ...quotedIn(lines.filter((line) => line.includes("%*"))), // the exec line first
    ...quotedIn(lines),
  ]
    // Skip bare variable references like "%_prog%" — that's the interpreter the
    // shim picks for itself, not a path we can resolve.
    .filter((token) => token && !/^%[^%]*%$/.test(token))
    // `%~dp0` expands WITH a trailing separator while `%dp0%` is usually written
    // followed by one, so supply a separator only when the token lacks it —
    // otherwise `%~dp0node_modules\cli.js` concatenates to `C:\npmnode_modules\…`.
    // The replacement is a FUNCTION, not a string: `$&`, `$$`, `` $` `` and `$'` are
    // special in a replacement pattern, and `$` is legal in a Windows directory
    // name, so a path like `C:\a$&b` would otherwise be mangled into nonsense.
    .map((token) =>
      token.replace(/%~?dp0%?([\\/])?/i, (_match, sep: string | undefined) =>
        sep ? `${shimDir}${sep}` : `${shimDir}\\`,
      ),
    )
    .map((token) => win32.normalize(win32.isAbsolute(token) ? token : win32.join(shimDir, token)));

  const target = candidates.find(deps.fileExists);
  if (!target) return { target: null, failure: { staleSelfUpdate: findStaleSelfUpdate(candidates, deps) } };

  const lower = target.toLowerCase();

  // A real executable: spawn it directly. No interpreter, no shell — exactly what
  // CreateProcess wants, and the best possible outcome.
  if (DIRECTLY_EXECUTABLE.some((ext) => lower.endsWith(ext))) return { target: { command: target, args: [] } };

  // A script: run it under node — the one npm placed beside the shim if present,
  // otherwise PATH's. The PATH fallback must itself be a real executable image:
  // on a machine whose only `node` is a `.cmd` shim (e.g. the desktop app's
  // Electron-as-Node shim), accepting that hit would just recreate the
  // can't-spawn-a-.cmd problem one level down.
  if (/\.[cm]?js$/.test(lower)) {
    const adjacentNode = win32.join(shimDir, "node.exe");
    const interpreter = deps.fileExists(adjacentNode)
      ? adjacentNode
      : findWindowsExecutableOnPath("node", deps);
    return interpreter ? { target: { command: interpreter, args: [target] } } : { target: null, failure: {} };
  }

  return { target: null, failure: {} };
}

/**
 * Detect the wreckage Claude Code's native self-updater leaves behind: it
 * renames the running `claude.exe` to `claude.exe.old.<ms-epoch>` before
 * writing the replacement, and when that write fails the shim's target is
 * gone while the rename survives. Shipped bug: every session spawn on the
 * machine then fails until the install is repaired, so the error message must
 * say what happened rather than "target could not be determined".
 */
function findStaleSelfUpdate(
  candidates: readonly string[],
  deps: Required<Pick<SpawnTargetDeps, "listDir">>,
): string | undefined {
  for (const candidate of candidates) {
    const base = win32.basename(candidate);
    let siblings: string[];
    try {
      siblings = deps.listDir(win32.dirname(candidate));
    } catch {
      continue;
    }
    const prefix = `${base}.old.`.toLowerCase();
    if (siblings.some((name) => name.toLowerCase().startsWith(prefix))) return candidate;
  }
  return undefined;
}

/**
 * Find `command` on PATH accepting only a real executable image (`.exe`/`.com`)
 * — never a `.cmd`/`.bat`/sh shim. For consumers that need a path they can hand
 * to `CreateProcess` directly, or embed in a command line that may be parsed by
 * either `cmd.exe` or Git Bash (e.g. the generated Claude Code hook command,
 * where a `.cmd` would resolve under one shell and not the other).
 *
 * Same PATH semantics as the spawn resolution above (";" splitting, quoted
 * entries), but the candidate set is `.exe`/`.com` only — deliberately NOT a
 * filter over `findOnPath`'s result, which returns the first hit of any kind
 * and would let a `.cmd` in an early PATH dir mask a real `node.exe` in a
 * later one.
 */
export function findWindowsExecutableOnPath(
  command: string,
  deps: Pick<SpawnTargetDeps, "env" | "fileExists"> = {},
): string | null {
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExists ?? existsSync;

  const candidates = (base: string): string[] =>
    hasExtension(base, DIRECTLY_EXECUTABLE) ? [base] : DIRECTLY_EXECUTABLE.map((ext) => base + ext);

  if (win32.isAbsolute(command) || /[\\/]/.test(command)) {
    return candidates(command).find(fileExists) ?? null;
  }
  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  for (const dir of pathEntries) {
    const hit = candidates(win32.join(dir, command)).find(fileExists);
    if (hit) return hit;
  }
  return null;
}

export function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  deps: SpawnTargetDeps = {},
): SpawnTarget {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { command, args: [...args] };

  const resolved: Required<Pick<SpawnTargetDeps, "env" | "fileExists" | "readText" | "listDir">> = {
    env: deps.env ?? process.env,
    fileExists: deps.fileExists ?? existsSync,
    readText: deps.readText ?? ((p) => readFileSync(p, "utf8")),
    listDir: deps.listDir ?? ((dir) => readdirSync(dir)),
  };

  // Already a real executable image (cmd.exe itself, an absolute .exe): launch it
  // as given. Resolving further would only add failure modes.
  if (hasExtension(command, DIRECTLY_EXECUTABLE)) return { command, args: [...args] };

  const found = findOnPath(command, resolved);
  if (!found) {
    // Same outcome CreateProcess would give, with a message that says why.
    throw new SpawnTargetError(
      `cannot spawn "${command}" on Windows: not found on PATH (searched with PATHEXT). ` +
        `Install it, or pass an absolute path to the executable.`,
    );
  }

  if (hasExtension(found, DIRECTLY_EXECUTABLE)) return { command: found, args: [...args] };

  if (hasExtension(found, SHIM_EXTENSIONS)) {
    const result = readShimTarget(found, resolved);
    if (result.target) return { command: result.target.command, args: [...result.target.args, ...args] };
    if (result.failure.staleSelfUpdate) {
      throw new SpawnTargetError(
        `cannot spawn "${found}" on Windows: its target "${result.failure.staleSelfUpdate}" is ` +
          `missing, but a renamed ".old" copy is present — the agent's self-updater replaced the ` +
          `binary and failed to write the new one. Restart the app to repair the install.`,
      );
    }
    throw new SpawnTargetError(
      `cannot spawn "${found}" on Windows: it is a .cmd/.bat shim whose target could not be ` +
        `determined, and running it through cmd.exe would expose arguments to shell parsing ` +
        `(command injection). Install a build that provides a real .exe, or point the harness ` +
        `at the interpreter and script directly.`,
    );
  }

  // Something like an extensionless sh script: not executable by CreateProcess,
  // and not a shim we can read. Refuse rather than shell out.
  throw new SpawnTargetError(
    `cannot spawn "${found}" on Windows: not an executable image and not a readable shim.`,
  );
}
