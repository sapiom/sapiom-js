/**
 * One discovery contract for Agent Studio's registry, live workspace watcher,
 * and folder picker. Keeping marker parsing and traversal policy here prevents
 * the three surfaces from disagreeing about whether a directory is an agent
 * project.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { AGENT_PROJECT_MARKER } from "../shared/types.js";

/**
 * How deep a scan looks for agent projects beneath a chosen root.
 *
 * This was 3, which predated the project-rooted rail: it assumed the root the
 * user opened was more or less the agent's own folder. Under a chosen project
 * root, depth is normal — `<root>/backend/src/agents/<agent>` is four segments
 * down and `<root>/apps/<app>/src/features/<x>/agents/<agent>` is six. At 3
 * those agents are not found at all and file under "No workspace"; on a
 * measured root that was well over a third of the rail.
 *
 * 8 leaves headroom above the deepest realistic layout without becoming a walk
 * of the user's home directory. It is NOT what keeps the scan cheap — see
 * AGENT_PROJECT_SCAN_MAX_NODES. What depth still buys is (a) a pathological
 * deep chain terminating in 8 steps rather than by exhausting a node budget,
 * and (b) a *deterministic* outer envelope, which reconciliation needs: the
 * registry may only forget a project it can prove it would have looked for.
 */
export const AGENT_PROJECT_SCAN_MAX_DEPTH = 8;

/**
 * The bound that actually governs scan cost: how many directories one walk may
 * enter. Depth alone cannot do this job, and the numbers are why.
 *
 * Measured on this machine (macOS/APFS) against real roots on a real install,
 * per directory entered = one marker `lstat` + one `readdir`, warm cache
 * ~22-25 us/dir at every depth:
 *
 *   root                    depth 3         depth 8            unbounded
 *   a single repo             119 dirs         242 dirs   7 ms    242 dirs
 *   ~/sapiom/sapiom-js        758 dirs       9,016 dirs 196 ms  9,195 dirs
 *   ~/sapiom/Sapiom         1,298 dirs      35,489 dirs 847 ms 47,544 dirs
 *
 * So raising the depth cap alone makes a 32 ms scan an 847 ms one on a root a
 * user would plausibly open, and the watcher below pays that synchronously on
 * a debounce. Cost is linear and predictable in directories entered, so that
 * is what we bound.
 *
 * Pruning harder by NAME was the other candidate and does not pay: extending
 * the ignored-directory list with the usual suspects (`.venv`, `target`,
 * `vendor`, `coverage`, `.turbo`, `__pycache__`, `out`, ...) removed 0.5-11% of
 * the dirs on the roots above. What is actually there is source directories
 * and, on the biggest root, 42,163 of 47,544 dirs in git worktree copies of the
 * repo itself.
 *
 * That second half IS now reachable, and not by name: see
 * {@link isForeignRepositoryRoot}. A walk that stops at a foreign checkout does
 * not enter those 42,163 directories at all, which is why the node budget is no
 * longer what ends a scan of a real root — the repository is. The budget stays
 * as the backstop for a tree that is genuinely one enormous checkout.
 *
 * **The tradeoff, stated plainly:** past the budget a scan is incomplete, and
 * an agent below the cut is not discovered on that pass. The walk is therefore
 * breadth-first, so the budget degrades by *depth* — every level below the cut
 * is complete, which is exactly the guarantee the old fixed cap gave, just at a
 * depth chosen by the tree's real width instead of guessed in advance. Callers
 * learn how far they may trust the result from
 * {@link AgentProjectScanBudget.envelopeDepth}; nothing beyond it is reconciled
 * away as missing.
 *
 * 10,000 dirs ~= 240 ms warm for the async registry scan, which runs when a
 * session is created or the user asks — and covers a real monorepo project root
 * outright (sapiom-js: 9,016).
 */
export const AGENT_PROJECT_SCAN_MAX_NODES = 10_000;

/**
 * The watcher must observe every directory the accepted discovery envelope can
 * later reconcile. Production fingerprints are async and shared per canonical
 * root, so keeping the same 10k breadth-first allowance avoids a permanently
 * blind suffix on polling-only platforms without multiplying event-loop work
 * per session/graph caller. The synchronous helper remains test/compat only.
 */
export const AGENT_PROJECT_WATCH_MAX_NODES = AGENT_PROJECT_SCAN_MAX_NODES;

/**
 * The entry name that marks a directory as its own repository checkout: a
 * `.git` DIRECTORY in an ordinary clone, a `.git` FILE in a git worktree or a
 * submodule. Both forms are one entry called `.git`, which is all this policy
 * needs to know.
 */
export const REPOSITORY_MARKER = ".git";

/**
 * Whether a directory we just listed is the root of a repository other than
 * the one the scan started in — the boundary a walk does not cross.
 *
 * **Why breadth, not depth, was the real bound.** The scan that produced this
 * install's 88-row registry was rooted one level too high, at `~/sapiom`. From
 * there the walk crossed into twelve sibling checkouts nobody had opened, and
 * kept going until the node budget cut it off:
 *
 * Measured on that install (macOS/APFS, warm cache) at the shipped 10,000-node
 * budget. Each cell is agents registered / distinct names among them /
 * directories entered / wall clock:
 *
 *   root                      today                          with the boundary
 *   ~/sapiom/wf-demo-testing   10 / 10,     17 dirs,   0 ms   10 / 10,    17 dirs,   0 ms
 *   ~/sapiom                   88 / 65, 10,000 dirs, 239 ms   68 / 64,   408 dirs,   8 ms
 *                              TRUNCATED at depth 5           complete
 *   ~/sapiom/sapiom-js         25 /  2,  9,016 dirs, 233 ms    2 /  2,   444 dirs,   8 ms
 *   ~/sapiom/Sapiom             0 /  0, 10,000 dirs, 200 ms    0 /  0, 5,408 dirs, 107 ms
 *                              TRUNCATED at depth 5           complete
 *
 * The `sapiom-js` row is the whole argument in one line. Of the 25 agents a
 * scan of that repo used to register, 24 were the SAME agent — one e2e fixture
 * — reachable once per git worktree under `.trees/`. Two were real. Read the
 * name counts down the column: the rule barely changes how many *distinct*
 * agents a scan finds, and collapses how many *rows* it writes.
 *
 * Letting the node budget off its leash widens the gap rather than closing it:
 * uncapped, `~/sapiom` is 141 agents across 83,969 directories in 6.8 s — and
 * still only 73 distinct names. Depth was never what was wrong.
 *
 * **The cost, stated plainly.** Across that pair, 5 distinct agents are lost at
 * `~/sapiom` (73 names uncapped vs 68 bounded), and `~/sapiom/Sapiom` loses the
 * single agent it has. Every one of them lives inside a checkout below the scan
 * root, and every one is registered the moment that checkout is itself the root
 * — opened as a project, hosting a session, or named to
 * `POST /api/workflows/scan`. That is the trade the user asked for in as many
 * words: "It's okay if we don't fully scan."
 *
 * It also costs nothing to evaluate: the walk has already listed the directory
 * to find its subdirectories, so the check reads a `Dirent[]` already in hand —
 * no extra syscall.
 *
 * **What it deliberately does NOT do.** A nested checkout that IS an agent (its
 * own `sapiom.json` at the top) is still registered: the marker is inspected
 * before the boundary is considered, and a marker stops the walk anyway. Only
 * a checkout that merely *contains* agents is left alone. So `~/agents/foo`
 * (one repo per agent) is found; `~/src/some-other-monorepo/**` is not, unless
 * the user points a scan at that monorepo.
 */
export function isForeignRepositoryRoot(entries: fs.Dirent[]): boolean {
  return entries.some((entry) => entry.name === REPOSITORY_MARKER);
}

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".sapiom",
  "dist",
  "build",
  ".next",
]);

export interface AgentProjectMarker {
  definitionId?: number | null;
  /** The agent's `defineAgent({ name })`, cached by `link`. */
  name?: string;
  /** Gallery-template provenance, written by clone (a clone carries `forkId` too). */
  templateId?: string | null;
  /** Fork record id, written by clone. */
  forkId?: string | null;
  /** Bundled-starter id, written by scaffold; `"default"` = bare scaffold. */
  starterId?: string | null;
}

/**
 * A detailed marker result for callers that must distinguish definitive
 * absence/invalidity from a transient filesystem failure. Most UI callers only
 * need the nullable wrappers below; registry reconciliation needs all states so
 * an unreadable project is not mistaken for a deleted one.
 */
export type AgentProjectMarkerInspection =
  | { status: "valid"; marker: AgentProjectMarker }
  | { status: "absent" | "invalid" | "unreadable" };

export interface AgentProjectMarkerInspectionHooks {
  /** Deterministic race seam: runs after lstat admission and before open. */
  beforeOpen?: (markerPath: string) => void | Promise<void>;
  /** Test-only observation that project-controlled bytes were actually read. */
  onBytesRead?: (bytes: number) => void;
}

export function isAgentProjectScanIgnoredDir(name: string): boolean {
  return IGNORED_DIR_NAMES.has(name);
}

/** A marker is JSON whose top-level value is an object (including `{}`). */
export function parseAgentProjectMarker(
  raw: string,
): AgentProjectMarker | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed as AgentProjectMarker;
  } catch {
    return null;
  }
}

/**
 * Resolve the fixed marker filename beneath the directory the user selected.
 * The folder picker deliberately accepts any absolute local directory, so the
 * selected directory itself is not confined to one application-owned root.
 * What we can and must prove is that the derived read stays inside that exact
 * directory rather than treating either input as a free-form file path.
 */
function resolveAgentProjectMarkerPath(dir: string): string | null {
  const resolvedDir = path.resolve(dir);
  const markerPath = path.resolve(resolvedDir, AGENT_PROJECT_MARKER);
  const relativeMarker = path.relative(resolvedDir, markerPath);
  if (
    !relativeMarker ||
    relativeMarker.startsWith(`..${path.sep}`) ||
    relativeMarker === ".." ||
    path.isAbsolute(relativeMarker)
  ) {
    return null;
  }
  return markerPath;
}

function markerReadErrorStatus(error: unknown): "absent" | "unreadable" {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
}

const AGENT_PROJECT_MARKER_MAX_BYTES = 64 * 1024;
const MARKER_OPEN_FLAGS =
  fs.constants.O_RDONLY |
  (fs.constants.O_NOFOLLOW ?? 0) |
  (fs.constants.O_NONBLOCK ?? 0);
const MARKER_FALLBACK_OPEN_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

function sameMarkerIdentity(
  expected: import("node:fs").Stats,
  actual: import("node:fs").Stats,
): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs &&
    actual.size <= AGENT_PROJECT_MARKER_MAX_BYTES
  );
}

function openMarkerSync(markerPath: string): number {
  try {
    return fs.openSync(markerPath, MARKER_OPEN_FLAGS);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EINVAL" ||
      MARKER_OPEN_FLAGS === MARKER_FALLBACK_OPEN_FLAGS
    ) {
      throw error;
    }
    // Some platforms do not implement O_NOFOLLOW. The pre-read fstat identity
    // check below is still fail-closed: a followed replacement can be opened,
    // but it is never read unless it is the exact lstat-authorized inode.
    return fs.openSync(markerPath, MARKER_FALLBACK_OPEN_FLAGS);
  }
}

async function openMarker(markerPath: string): Promise<fsp.FileHandle> {
  try {
    return await fsp.open(markerPath, MARKER_OPEN_FLAGS);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EINVAL" ||
      MARKER_OPEN_FLAGS === MARKER_FALLBACK_OPEN_FLAGS
    ) {
      throw error;
    }
    return fsp.open(markerPath, MARKER_FALLBACK_OPEN_FLAGS);
  }
}

export function readAgentProjectMarkerSync(
  dir: string,
): AgentProjectMarker | null {
  const result = inspectAgentProjectMarkerSync(dir);
  return result.status === "valid" ? result.marker : null;
}

export function inspectAgentProjectMarkerSync(
  dir: string,
): AgentProjectMarkerInspection {
  const markerPath = resolveAgentProjectMarkerPath(dir);
  if (!markerPath) return { status: "invalid" };

  let markerStat: import("node:fs").Stats;
  try {
    markerStat = fs.lstatSync(markerPath);
  } catch (error) {
    return { status: markerReadErrorStatus(error) };
  }

  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    return { status: "invalid" };
  }

  let fd: number | null = null;
  try {
    fd = openMarkerSync(markerPath);
    const openedStat = fs.fstatSync(fd);
    if (!sameMarkerIdentity(markerStat, openedStat)) {
      return { status: "unreadable" };
    }
    const buffer = Buffer.alloc(openedStat.size + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const finalStat = fs.fstatSync(fd);
    if (
      bytesRead !== openedStat.size ||
      !sameMarkerIdentity(openedStat, finalStat)
    ) {
      return { status: "unreadable" };
    }
    const marker = parseAgentProjectMarker(
      buffer.subarray(0, bytesRead).toString("utf8"),
    );
    return marker ? { status: "valid", marker } : { status: "invalid" };
  } catch (error) {
    return { status: markerReadErrorStatus(error) };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export async function readAgentProjectMarker(
  dir: string,
): Promise<AgentProjectMarker | null> {
  const result = await inspectAgentProjectMarker(dir);
  return result.status === "valid" ? result.marker : null;
}

export async function inspectAgentProjectMarker(
  dir: string,
  hooks: AgentProjectMarkerInspectionHooks = {},
): Promise<AgentProjectMarkerInspection> {
  const markerPath = resolveAgentProjectMarkerPath(dir);
  if (!markerPath) return { status: "invalid" };

  let markerStat: import("node:fs").Stats;
  try {
    markerStat = await fsp.lstat(markerPath);
  } catch (error) {
    return { status: markerReadErrorStatus(error) };
  }

  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    return { status: "invalid" };
  }

  let handle: fsp.FileHandle | null = null;
  try {
    await hooks.beforeOpen?.(markerPath);
    handle = await openMarker(markerPath);
    const openedStat = await handle.stat();
    if (!sameMarkerIdentity(markerStat, openedStat)) {
      return { status: "unreadable" };
    }
    const buffer = Buffer.alloc(openedStat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 0) hooks.onBytesRead?.(bytesRead);
    const finalStat = await handle.stat();
    if (
      bytesRead !== openedStat.size ||
      !sameMarkerIdentity(openedStat, finalStat)
    ) {
      return { status: "unreadable" };
    }
    const marker = parseAgentProjectMarker(
      buffer.subarray(0, bytesRead).toString("utf8"),
    );
    return marker ? { status: "valid", marker } : { status: "invalid" };
  } catch (error) {
    return { status: markerReadErrorStatus(error) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Overridable halves of the traversal policy — tests and benchmarks vary these. */
export interface AgentProjectScanLimits {
  maxDepth: number;
  maxNodes: number;
}

/** One logical workspace reconciliation allowance shared by direct-root walks. */
export class AgentProjectScanAllowance {
  readonly maxNodes: number;
  visited = 0;

  constructor(maxNodes = AGENT_PROJECT_SCAN_MAX_NODES) {
    this.maxNodes = maxNodes;
  }

  admit(): boolean {
    if (this.visited >= this.maxNodes) return false;
    this.visited += 1;
    return true;
  }
}

/**
 * One walk's traversal allowance, and its report on what it managed to cover.
 *
 * A budget is single-use: it accumulates `visited` as the walk runs, so pass a
 * fresh one per walk (the walkers below default to one). Callers that care
 * about cost or completeness construct it themselves and read it afterwards —
 * that is also how the perf benchmark measures nodes visited without the
 * scanner growing a second, parallel counting path.
 */
export class AgentProjectScanBudget implements AgentProjectScanLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  /** Directories entered (marker inspected), root included. */
  visited = 0;
  /** The depth at which `maxNodes` stopped the walk, or null if it never did. */
  truncatedAtDepth: number | null = null;
  /**
   * Foreign repository roots the walk stopped at rather than entering.
   *
   * Rides on the budget for the same reason `visited` does: a caller holding the
   * budget can read what the walk actually did without every intermediate
   * signature having to forward it. Load-bearing for the UI — a scan of a
   * non-repo folder full of clones finds nothing, and only this list can tell
   * "there is nothing here" apart from "I did not look in there".
   */
  repositoryBoundaries: string[] = [];

  constructor(
    limits: Partial<AgentProjectScanLimits> = {},
    private readonly sharedAllowance?: AgentProjectScanAllowance,
  ) {
    this.maxDepth = limits.maxDepth ?? AGENT_PROJECT_SCAN_MAX_DEPTH;
    this.maxNodes = limits.maxNodes ?? AGENT_PROJECT_SCAN_MAX_NODES;
  }

  get truncated(): boolean {
    return this.truncatedAtDepth !== null;
  }

  /**
   * The deepest level this walk enumerated *in full* — how deep its results may
   * be trusted as complete, and therefore how deep a caller may reconcile a
   * previously-known project away as gone. `maxDepth` for a walk that finished;
   * one level above the cut for a walk the node budget stopped, because that
   * level is the only incomplete one (the walk is breadth-first).
   */
  get envelopeDepth(): number {
    return this.truncatedAtDepth === null
      ? this.maxDepth
      : this.truncatedAtDepth - 1;
  }

  /** Charges one directory. False (and records the cut) once spent. */
  admit(depth: number): boolean {
    if (
      this.visited >= this.maxNodes ||
      (this.sharedAllowance && !this.sharedAllowance.admit())
    ) {
      if (this.truncatedAtDepth === null) this.truncatedAtDepth = depth;
      return false;
    }
    this.visited += 1;
    return true;
  }
}

/** What the walk should do with a directory it just entered. */
export type AgentProjectWalkAction =
  /** Record it and go no deeper — it is a project, or an opaque subtree. */
  | "stop"
  /** Not a project: enumerate its subdirectories and keep going. */
  | "descend";

export interface AgentProjectWalkVisitor<
  Action = AgentProjectWalkAction | Promise<AgentProjectWalkAction>,
> {
  /** Every directory entered, root first, shallowest level first. */
  onDirectory(dir: string, depth: number): Action;
  /**
   * A directory whose entries were read and whose repository boundary was
   * admitted. Marker inspection belongs in `onDirectory`; source discovery
   * belongs here so an unmarked `index.ts` never crosses into another checkout.
   */
  onAdmittedDirectory?(
    dir: string,
    depth: number,
    entries: fs.Dirent[],
  ): Action;
  /** `dir`'s entries could not be listed, and not because it is gone. */
  onUnreadable?(dir: string, depth: number): void;
  /**
   * `dir` is a repository checkout of its own and was not descended into — see
   * {@link isForeignRepositoryRoot}. Reported so a caller can say what it
   * declined to look inside rather than silently returning a short list.
   */
  onRepositoryBoundary?(dir: string, depth: number): void;
}

/** Traversal policy a caller may vary; the defaults are what ships. */
export interface AgentProjectWalkOptions {
  /**
   * Descend into nested repository checkouts as if they were ordinary
   * directories — the pre-boundary behaviour. Off by default, and only ever
   * turned on to MEASURE the difference (see agent-project-scan.perf.test.ts).
   * Turning it on in a product path re-opens the accumulation this boundary
   * exists to stop.
   */
  crossRepositoryBoundaries?: boolean;
}

/**
 * Subdirectories worth descending into, in a stable order.
 *
 * Two properties matter beyond the ignore filter:
 *
 *   - `entry.isDirectory()` reads the raw dirent type, so a symlink — even one
 *     pointing at a directory — reports false and is never descended into.
 *     That, not the depth cap, is what makes a symlink *cycle* terminate; the
 *     cap only ever hid the fact. It is asserted directly in the tests.
 *   - Sorted, so a walk the node budget truncates truncates at the same place
 *     twice. `readdir` order is filesystem-dependent, and the watcher compares
 *     one fingerprint against the next: an order-dependent cut would read as a
 *     structural change on every check and rescan the workspace forever.
 */
function scanSubdirNames(entries: fs.Dirent[]): string[] {
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && !isAgentProjectScanIgnoredDir(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

function isConfirmedMissingDir(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The boundary decision, shared by the sync and async walks so they cannot
 * disagree about which directories a scan of a given root covers.
 *
 * Depth 0 is exempt: the root is the tree the user asked for, and a scan of a
 * repository must of course cover that repository. Everything below it is only
 * entered while it belongs to the same checkout.
 */
function stopsAtRepositoryBoundary(
  visitor: AgentProjectWalkVisitor<
    AgentProjectWalkAction | Promise<AgentProjectWalkAction>
  >,
  entries: fs.Dirent[],
  dir: string,
  depth: number,
  options: AgentProjectWalkOptions,
): boolean {
  if (options.crossRepositoryBoundaries) return false;
  if (depth === 0 || !isForeignRepositoryRoot(entries)) return false;
  visitor.onRepositoryBoundary?.(dir, depth);
  return true;
}

/**
 * Breadth-first, depth- and node-bounded traversal beneath `root` — the one
 * traversal policy the registry and the workspace watcher both run, so they
 * cannot disagree about which directories a scan of a given root covers.
 *
 * Breadth-first is load-bearing rather than incidental: it is what makes the
 * node budget degrade by depth (see AGENT_PROJECT_SCAN_MAX_NODES). Every level
 * shallower than `budget.envelopeDepth` is complete no matter where the budget
 * ran out, which keeps the generalized bound a superset of the fixed depth cap
 * it replaces.
 *
 * Returns the budget so a caller can read `visited` / `envelopeDepth` off it.
 */
export function walkAgentProjectTree(
  root: string,
  visitor: AgentProjectWalkVisitor<AgentProjectWalkAction>,
  budget: AgentProjectScanBudget = new AgentProjectScanBudget(),
  options: AgentProjectWalkOptions = {},
): AgentProjectScanBudget {
  let frontier = [path.resolve(root)];
  for (
    let depth = 0;
    depth <= budget.maxDepth && frontier.length > 0;
    depth += 1
  ) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (!budget.admit(depth)) return budget;
      if (visitor.onDirectory(dir, depth) === "stop") continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if (!isConfirmedMissingDir(error)) visitor.onUnreadable?.(dir, depth);
        continue;
      }
      if (stopsAtRepositoryBoundary(visitor, entries, dir, depth, options))
        continue;
      if (visitor.onAdmittedDirectory?.(dir, depth, entries) === "stop")
        continue;
      for (const name of scanSubdirNames(entries))
        next.push(path.join(dir, name));
    }
    frontier = next;
  }
  return budget;
}

/**
 * Async twin of {@link walkAgentProjectTree}, for callers that must not block
 * the event loop on a wide tree. Same order, same bounds, same decisions — so
 * the two produce identical results on the same tree with the same budget,
 * which the watcher's sync/async fingerprint pair depends on.
 */
export async function walkAgentProjectTreeAsync(
  root: string,
  visitor: AgentProjectWalkVisitor<
    AgentProjectWalkAction | Promise<AgentProjectWalkAction>
  >,
  budget: AgentProjectScanBudget = new AgentProjectScanBudget(),
  options: AgentProjectWalkOptions = {},
): Promise<AgentProjectScanBudget> {
  let frontier = [path.resolve(root)];
  for (
    let depth = 0;
    depth <= budget.maxDepth && frontier.length > 0;
    depth += 1
  ) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (!budget.admit(depth)) return budget;
      if ((await visitor.onDirectory(dir, depth)) === "stop") continue;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (!isConfirmedMissingDir(error)) visitor.onUnreadable?.(dir, depth);
        continue;
      }
      if (stopsAtRepositoryBoundary(visitor, entries, dir, depth, options))
        continue;
      if (
        visitor.onAdmittedDirectory &&
        (await visitor.onAdmittedDirectory(dir, depth, entries)) === "stop"
      ) {
        continue;
      }
      for (const name of scanSubdirNames(entries))
        next.push(path.join(dir, name));
    }
    frontier = next;
  }
  return budget;
}
