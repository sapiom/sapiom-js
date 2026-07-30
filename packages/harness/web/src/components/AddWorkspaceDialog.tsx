import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import type { FsListResponse } from "../lib/api";
import {
  isValidProjectName,
  nextAvailableName,
  parentOf,
  projectDirSuggestion,
  slugifyIdea,
} from "../lib/project-dir";
import { loadUiPrefs } from "../lib/ui-prefs";
import { useDismissable } from "../lib/use-dismissable";
import { Icon } from "./Icon";
import { DirectoryPicker } from "./DirectoryPicker";
import { track } from "../lib/track";
import type { HarnessEntry, HarnessKind } from "@shared/types";

/**
 * Add a workspace: three doors.
 *
 * Replaces `NewSessionModal mode="workspace"`, which did FIVE jobs at once
 * (register · scaffold · template · bulk-scan · install-MCP) with 17
 * interactive controls to answer one question, and asked for the folder three
 * different ways (text field, recents chips, embedded tree) which visibly
 * disagreed with each other.
 *
 * The fix is to branch on INTENT before asking for a path:
 *
 *   Open a folder         → which folder? → detection → the ONE right action
 *   Start from a template → hands off to the templates destination (which asks
 *                           "which template?" and owns the live catalog)
 *   Start from an idea    → what should it do? → derived name → scaffold
 *
 * Everything that used to be a permanent button is now an OUTCOME of what
 * detection found: scaffold, template, bulk-scan and MCP-setup only appear when
 * the folder you picked actually implies them. That is only possible because
 * `FsDirEntry.hasAgentProject` exists — without it the dialog cannot tell an
 * agent project from any other folder and has to offer everything, which is
 * exactly how the old one ended up the way it did.
 *
 * Design: plans/sapiom-harness/add-workspace-c-spec-*.md and
 * plans/harness-idea-door/design.md in the Sapiom repo.
 */

export type Door = "have" | "template" | "idea";

/** What detection found at the resolved path. */
type Outcome =
  | { kind: "project" }
  | { kind: "multi"; found: number }
  | { kind: "plain" }
  | { kind: "new" };

interface AddWorkspaceDialogProps {
  recentDirs: string[];
  /** Where NEW projects go (resolveProjectRoot: setting → host default → launch dir). */
  projectRoot: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  onClose: () => void;
  /** Register an existing agent project (door 1, `project` outcome). */
  onConnect: (cwd: string) => Promise<void>;
  /** Bulk-register every project under a root (door 1, `multi` outcome). */
  onScan: (root: string) => Promise<number>;
  /** Start a session at `cwd` and hand the agent a scaffold prompt carrying
   *  `idea` (door 1's `plain`/`new` outcomes and door 3). */
  onScaffold: (cwd: string, harness: HarnessKind, idea?: string) => Promise<void>;
  /** Door 2 — hands off to the templates destination rather than duplicating the catalog. */
  onBrowseTemplates: () => void;
  /** Adapter registry — supplies the per-agent MCP setup prompts offered when
   *  detection says the folder has no Sapiom wiring. */
  listHarnesses: () => Promise<HarnessEntry[]>;
  /** Persist a changed project root as the user's default. */
  onSaveProjectRoot: (root: string) => Promise<void>;
  /** The button that opened the dialog — Escape returns focus to it. */
  triggerRef?: RefObject<HTMLElement | null>;
  /**
   * Open straight into one door, skipping the door list.
   *
   * For callers that have ALREADY asked the intent question — the rail's Add
   * popover (which renders the doors itself) and Overview's "Open a folder"
   * row. Without it both asked twice: you clicked a button naming an intent and
   * the dialog answered with the same three intents, the one you picked among
   * them. When set there is no list behind this door, so the back button is
   * suppressed rather than left pointing at a state you were never in.
   */
  initialDoor?: Door;
}

/** The three intents, and the single source of the row copy. Exported because
 *  the rail's Add popover renders this same list — two hand-maintained copies
 *  of three labels is exactly how "Open a folder" and "I have a project" came
 *  to name the same action on two surfaces. */
export const DOORS: { id: Door; title: string; sub: string; icon: "Folder" | "LayoutTemplate" | "Sparkles" }[] = [
  { id: "have", title: "Open a folder", sub: "Add a folder that already holds an agent", icon: "Folder" },
  { id: "template", title: "Start from a template", sub: "Ready-made workflows you can edit", icon: "LayoutTemplate" },
  { id: "idea", title: "Start from an idea", sub: "Describe it; the agent scaffolds it", icon: "Sparkles" },
];

export function AddWorkspaceDialog({
  recentDirs,
  projectRoot,
  listDir,
  onClose,
  onConnect,
  onScan,
  onScaffold,
  onBrowseTemplates,
  onSaveProjectRoot,
  listHarnesses,
  triggerRef,
  initialDoor,
}: AddWorkspaceDialogProps): JSX.Element {
  const [door, setDoor] = useState<Door | null>(initialDoor ?? null);
  // The adapter registry, for the MCP setup prompts the "no agent project"
  // outcome offers. Fetched once per open; a failure just means that block
  // renders nothing, which is strictly better than a broken affordance.
  const [entries, setEntries] = useState<HarnessEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    listHarnesses()
      .then((registry) => {
        if (!cancelled) setEntries(registry);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [listHarnesses]);
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissable(true, { onDismiss: onClose, containerRef: panelRef, triggerRef });

  const activeDoor = DOORS.find((entry) => entry.id === door) ?? null;

  const pickDoor = (next: Door): void => {
    if (next === "template") {
      // The template door IS the templates dialog — no intermediate step.
      onBrowseTemplates();
      return;
    }
    setDoor(next);
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal modal-add-workspace"
        role="dialog"
        aria-label={activeDoor ? activeDoor.title : "Add to Sapiom"}
        ref={panelRef}
      >
        <div className="modal-header">
          {/* Back exists only when there is a list to go back TO. Entered
              directly at a door, the intent was picked on the surface that
              opened us, and "back" would land on a state this dialog was never
              in. Closing is the way out. */}
          {door && !initialDoor && (
            <button
              type="button"
              className="theme-toggle aw-back"
              aria-label="Back to all options"
              data-testid="aw-back"
              onClick={() => setDoor(null)}
            >
              <Icon name="ArrowLeft" size={14} />
            </button>
          )}
          <span className="aw-title">{activeDoor ? activeDoor.title : "Add to Sapiom"}</span>
          <button className="theme-toggle modal-close" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="X" size={14} />
          </button>
        </div>

        {!door && <DoorList onPick={pickDoor} />}

        {door === "have" && (
          <HaveProjectDoor
            recentDirs={recentDirs}
            listDir={listDir}
            onConnect={onConnect}
            onScan={onScan}
            onScaffold={onScaffold}
            onBrowseTemplates={onBrowseTemplates}
            entries={entries}
            onDone={onClose}
          />
        )}

        {door === "idea" && (
          <IdeaDoor
            projectRoot={projectRoot}
            listDir={listDir}
            onScaffold={onScaffold}
            onSaveProjectRoot={onSaveProjectRoot}
            onDone={onClose}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The resting state: three mutually exclusive intents, no path field in sight.
 *
 * Exported so the rail's Add popover can BE this list rather than restate it.
 * The row anatomy (icon · title · sub · chevron) is the same on both surfaces,
 * so it is one component and one stylesheet rule, not two that drift.
 */
export function DoorList({ onPick }: { onPick: (door: Door) => void }): JSX.Element {
  return (
    <div className="aw-doors" data-testid="aw-doors">
      {DOORS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="aw-door"
          data-testid={`aw-door-${entry.id}`}
          onClick={() => onPick(entry.id)}
        >
          <span className="aw-door-icon" aria-hidden="true">
            <Icon name={entry.icon} size={15} />
          </span>
          <span className="aw-door-text">
            <span className="aw-door-title">{entry.title}</span>
            <span className="aw-door-sub">{entry.sub}</span>
          </span>
          <span className="aw-door-arrow" aria-hidden="true">
            <Icon name="ArrowRight" size={14} />
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Door 1 — Open a folder
// ---------------------------------------------------------------------------

function HaveProjectDoor({
  recentDirs,
  listDir,
  onConnect,
  onScan,
  onScaffold,
  onBrowseTemplates,
  entries,
  onDone,
}: {
  recentDirs: string[];
  listDir: (path?: string) => Promise<FsListResponse>;
  onConnect: (cwd: string) => Promise<void>;
  onScan: (root: string) => Promise<number>;
  onScaffold: (cwd: string, harness: HarnessKind, idea?: string) => Promise<void>;
  onBrowseTemplates: () => void;
  entries: HarnessEntry[];
  onDone: () => void;
}): JSX.Element {
  const [cwd, setCwd] = useState(recentDirs[0] ?? "");
  const [newDirTyped, setNewDirTyped] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Detection for the picked path. Two questions, both answered by the listing
   * endpoint's flag: is the path ITSELF a project (ask its parent), and does it
   * CONTAIN projects (ask the path)?
   */
  const detect = useCallback(async (): Promise<void> => {
    const target = stripTrailingSlash(cwd.trim());
    if (!target) return;
    if (newDirTyped) {
      setOutcome({ kind: "new" });
      return;
    }
    setChecking(true);
    setError(null);
    const parent = parentOf(target);
    try {
      // The parent listing is how a path learns about ITSELF: the endpoint
      // reports one level down, so `target`'s own marker only shows up as an
      // entry in its parent's listing.
      const self = parent ? await listDir(parent) : null;
      const isProject = Boolean(
        self?.dirs.some((dir) => stripTrailingSlash(dir.path) === target && dir.hasAgentProject),
      );
      if (isProject) {
        setOutcome({ kind: "project" });
        return;
      }

      const children = await listDir(target);
      // The two hosts disagree about a path that doesn't exist: the real server
      // 404s (handled in the catch below) while the mock silently resolves up to
      // the nearest existing ancestor. Comparing the RESOLVED path to what we
      // asked for is the signal that works for both — without it, a typed
      // not-yet-existing folder inherits its ancestor's contents and gets
      // reported as "N projects under this folder".
      if (stripTrailingSlash(children.path) !== target) {
        setOutcome({ kind: "new" });
        return;
      }
      const inside = children.dirs.filter((dir) => dir.hasAgentProject).length;
      setOutcome(inside > 0 ? { kind: "multi", found: inside } : { kind: "plain" });
    } catch {
      // Unreadable target, readable parent → a folder that doesn't exist yet
      // (the real server's 404 path). Both unreadable is a real error.
      try {
        if (parent) await listDir(parent);
        setOutcome({ kind: "new" });
      } catch {
        setError("Couldn't read that directory.");
      }
    } finally {
      setChecking(false);
    }
  }, [cwd, newDirTyped, listDir]);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (outcome) {
    return (
      <>
        <ResultBlock
          path={cwd.trim()}
          outcome={outcome}
          busy={busy}
          onChange={() => setOutcome(null)}
          onConnect={() => void run(() => onConnect(cwd.trim()))}
          onScan={() =>
            void run(async () => {
              const found = await onScan(cwd.trim());
              // Zero found keeps the dialog open so the path can be adjusted —
              // closing on nothing would look like it worked.
              if (found === 0) throw new Error("No agent projects found under this folder.");
            })
          }
          onScaffold={() => void run(() => onScaffold(cwd.trim(), preferredHarness()))}
          onBrowseTemplates={onBrowseTemplates}
          entries={entries}
        />
        {error && <div className="modal-error">{error}</div>}
      </>
    );
  }

  return (
    <>
      <div className="modal-body">
        <section className="modal-section">
          <DirectoryPicker
            value={cwd}
            onChange={setCwd}
            onSubmit={() => void detect()}
            recentDirs={recentDirs}
            listDir={listDir}
            onNewDirChange={setNewDirTyped}
          />
        </section>
        <p className="modal-field-hint">
          Any folder — we&apos;ll tell you what we find in it.
        </p>
        {error && <div className="modal-error">{error}</div>}
      </div>
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onDone} disabled={checking}>
          Cancel
        </button>
        <button
          className="btn-primary modal-primary-cta"
          data-testid="aw-have-continue"
          onClick={() => void detect()}
          disabled={checking || !cwd.trim()}
        >
          {checking ? "Checking…" : "Continue"}
        </button>
      </div>
    </>
  );
}

/**
 * "This project isn't wired to Sapiom yet" — the job the old dialog spent five
 * permanent `Copy for <agent>` buttons on, in a 5-wide grid that was roughly 40%
 * of its height and shown even when the selected folder was already a perfectly
 * wired agent project.
 *
 * Two changes. It is CONTEXTUAL: it appears only inside the "no agent project"
 * outcome, because that is the only case it answers. And it is ONE row plus a
 * disclosure rather than five buttons: the agent you actually use is the primary
 * affordance, the rest are behind a caret.
 *
 * Still copy-a-prompt for now. What the prompt contains is a shell command
 * (`claude mcp add sapiom-dev -- npx -y @sapiom/mcp`), so a desktop build can
 * run it for you — that needs the Electron preload and is deliberately a
 * separate change; this is the same capability, minus the clutter.
 */
function McpOffer({ entries }: { entries: HarnessEntry[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const withPrompts = entries.filter((entry) => entry.installMcpPrompt.trim().length > 0);
  if (withPrompts.length === 0) return null;

  // The agent the user actually runs leads; everything else is behind the caret.
  const preferred = preferredHarness();
  const primary = withPrompts.find((entry) => entry.id === preferred) ?? withPrompts[0];
  const rest = withPrompts.filter((entry) => entry.id !== primary.id);

  const copy = (entry: HarnessEntry): void => {
    void navigator.clipboard
      ?.writeText(entry.installMcpPrompt)
      .then(() => {
        track("mcp.install", { harness: entry.id });
        setCopiedId(entry.id);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopiedId(null), 1600);
      })
      .catch(() => {});
  };

  return (
    <div className="aw-mcp" data-testid="mcp-install">
      <div className="aw-mcp-row">
        <span className="aw-mcp-text">
          Also drive this project from your own terminal?{" "}
          <span className="aw-mcp-dim">Sapiom MCP isn&apos;t set up here.</span>
        </span>
        <button
          type="button"
          className="btn-ghost"
          data-testid={`mcp-install-copy-${primary.id}`}
          onClick={() => copy(primary)}
        >
          <Icon name="Copy" size={13} />
          {copiedId === primary.id ? "Copied" : `Copy setup prompt`}
        </button>
        {rest.length > 0 && (
          <button
            type="button"
            className="btn-ghost aw-mcp-more"
            aria-expanded={open}
            aria-label="Setup prompts for other agents"
            data-testid="mcp-install-more"
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} />
          </button>
        )}
      </div>
      {open && (
        <div className="aw-mcp-list">
          {rest.map((entry) => (
            <div key={entry.id} className="aw-mcp-list-row">
              <span className="aw-mcp-text">{entry.label}</span>
              <button
                type="button"
                className="btn-ghost"
                data-testid={`mcp-install-copy-${entry.id}`}
                onClick={() => copy(entry)}
              >
                <Icon name="Copy" size={13} />
                {copiedId === entry.id ? "Copied" : "Copy"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * State the finding, then offer exactly the actions it implies — nothing
 * pre-emptive. A full-bleed hairline-separated block, not a floating card:
 * this dialog's anatomy is header / body / footer blocks.
 */
function ResultBlock({
  path,
  outcome,
  busy,
  onChange,
  onConnect,
  onScan,
  onScaffold,
  onBrowseTemplates,
  entries,
}: {
  path: string;
  outcome: Outcome;
  busy: boolean;
  onChange: () => void;
  onConnect: () => void;
  onScan: () => void;
  onScaffold: () => void;
  onBrowseTemplates: () => void;
  entries: HarnessEntry[];
}): JSX.Element {
  const good = outcome.kind === "project" || outcome.kind === "multi";
  return (
    <>
      <div className="aw-result" data-tone={good ? "good" : "todo"} data-testid="aw-result" aria-live="polite">
        <div className="aw-result-head">
          <span className="aw-result-glyph" aria-hidden="true">
            <Icon name={good ? "Check" : "TriangleAlert"} size={14} />
          </span>
          <span className="aw-result-text">
            <span className="aw-result-title">
              {outcome.kind === "project" && "This is an agent project"}
              {outcome.kind === "multi" &&
                `${outcome.found} agent ${outcome.found === 1 ? "project" : "projects"} under this folder`}
              {outcome.kind === "plain" && "No agent project in this folder"}
              {outcome.kind === "new" && "This folder doesn't exist yet"}
            </span>
            <span className="aw-result-path" title={path}>
              {path}
            </span>
          </span>
          <button type="button" className="btn-ghost aw-result-change" onClick={onChange} disabled={busy}>
            Change
          </button>
        </div>
        {/* Only here: the folder exists and has no Sapiom wiring. */}
        {outcome.kind === "plain" && <McpOffer entries={entries} />}
      </div>

      <div className="modal-actions">
        {outcome.kind === "project" && (
          <button className="btn-primary modal-primary-cta" data-testid="aw-add" onClick={onConnect} disabled={busy}>
            {busy ? "Adding…" : "Add workspace"}
          </button>
        )}
        {outcome.kind === "multi" && (
          <button className="btn-primary modal-primary-cta" data-testid="aw-add-all" onClick={onScan} disabled={busy}>
            {busy ? "Adding…" : `Add all ${outcome.found}`}
          </button>
        )}
        {(outcome.kind === "plain" || outcome.kind === "new") && (
          <>
            <button type="button" className="btn-ghost" onClick={onBrowseTemplates} disabled={busy}>
              <Icon name="LayoutTemplate" size={13} />
              Start from a template
            </button>
            {/* A bare folder with no agent is a legitimate rail citizen — the
                rail renders those and offers "scaffold in this session" on
                them. The old dialog could register one, so this must too;
                dropping it would quietly remove a capability. Only for a
                folder that EXISTS: there is nothing to register otherwise. */}
            {outcome.kind === "plain" && (
              <button
                type="button"
                className="btn-ghost"
                data-testid="aw-add-anyway"
                onClick={onConnect}
                disabled={busy}
                title="Add the folder as a workspace now and scaffold an agent in it later"
              >
                Add folder anyway
              </button>
            )}
            <button
              className="btn-primary modal-primary-cta"
              data-testid="aw-scaffold-here"
              onClick={onScaffold}
              disabled={busy}
            >
              <Icon name="Sparkles" size={13} />
              {busy ? "Starting…" : "Scaffold an agent here"}
            </button>
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Door 3 — Start from an idea
// ---------------------------------------------------------------------------

/**
 * A folder is unavoidable here, which is the whole reason this door has two
 * fields instead of one: a session is a PTY with a `cwd`, `sapiom agents init .`
 * writes into it, and `scaffold()` refuses a non-empty target — so the folder
 * must exist, be empty, and be NAMED before the agent can read the idea. The
 * name is therefore derived client-side (nothing smarter can run yet) and the
 * resolved path is a statement rather than a field.
 */
function IdeaDoor({
  projectRoot,
  listDir,
  onScaffold,
  onSaveProjectRoot,
  onDone,
}: {
  projectRoot: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  onScaffold: (cwd: string, harness: HarnessKind, idea?: string) => Promise<void>;
  onSaveProjectRoot: (root: string) => Promise<void>;
  onDone: () => void;
}): JSX.Element {
  const [idea, setIdea] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [root, setRoot] = useState(projectRoot ?? "");
  const [rootEditing, setRootEditing] = useState(false);
  const [rootSaved, setRootSaved] = useState(false);
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What already sits in the root, so a collision is reported before submit
  // instead of surfacing as agent-core's DIR_NOT_EMPTY afterwards.
  useEffect(() => {
    const target = root.trim();
    if (!target) return;
    let cancelled = false;
    listDir(target)
      .then((res) => {
        if (!cancelled) setTaken(new Set(res.dirs.map((dir) => dir.name)));
      })
      // A root that doesn't exist yet has nothing in it — not an error.
      .catch(() => {
        if (!cancelled) setTaken(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [root, listDir]);

  const onIdeaChange = (next: string): void => {
    setIdea(next);
    // The name tracks the idea until the user takes it over. The suggestion
    // auto-suffixes past a collision; a name the user typed never does.
    if (!nameEdited) setName(nextAvailableName(slugifyIdea(next), taken));
  };

  const trimmedName = name.trim();
  const nameValid = isValidProjectName(trimmedName);
  const collides = nameValid && taken.has(trimmedName);
  const target = projectDirSuggestion(trimmedName, root);
  const canSubmit = Boolean(idea.trim()) && nameValid && !collides && Boolean(target) && !busy;

  const hint = (): string => {
    if (!trimmedName) return "Becomes the agent's name.";
    if (!nameValid) return "Lowercase letters, numbers and dashes only — it becomes the package name.";
    if (collides) return "That folder already exists here. Pick another name.";
    return "Becomes the agent's name.";
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onScaffold(target, preferredHarness(), idea.trim());
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const saveRoot = async (next: string): Promise<void> => {
    const trimmed = next.trim();
    if (!trimmed) return;
    setRoot(trimmed);
    setRootEditing(false);
    try {
      await onSaveProjectRoot(trimmed);
      setRootSaved(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <div className="modal-body">
        <label className="aw-field" htmlFor="aw-idea">
          <span className="aw-field-label">What should it do?</span>
          <textarea
            id="aw-idea"
            className="modal-input aw-textarea"
            data-testid="aw-idea"
            rows={3}
            value={idea}
            placeholder="Every morning, diff our competitors' pricing pages and Slack me the changes."
            onChange={(event) => onIdeaChange(event.target.value)}
          />
        </label>

        <label className="aw-field" htmlFor="aw-name">
          <span className="aw-field-label">Name</span>
          <input
            id="aw-name"
            className="modal-input"
            data-testid="aw-name"
            value={name}
            spellCheck={false}
            aria-invalid={Boolean(trimmedName) && (!nameValid || collides)}
            onChange={(event) => {
              setName(event.target.value);
              setNameEdited(true);
            }}
          />
        </label>

        {rootEditing ? (
          <section className="modal-section aw-root-picker">
            <DirectoryPicker
              value={root}
              onChange={setRoot}
              onSubmit={() => void saveRoot(root)}
              recentDirs={[]}
              listDir={listDir}
            />
            <div className="aw-root-actions">
              <button type="button" className="btn-ghost" onClick={() => setRootEditing(false)}>
                Cancel
              </button>
              <button type="button" className="btn-ghost" onClick={() => void saveRoot(root)}>
                Use this folder
              </button>
            </div>
          </section>
        ) : (
          <div className="aw-target">
            <span className="aw-target-path" data-testid="aw-target" title={target || root}>
              {target || `${root}/…`}
            </span>
            <button
              type="button"
              className="btn-ghost aw-root-change"
              data-testid="aw-change-root"
              onClick={() => setRootEditing(true)}
            >
              Change root…
            </button>
          </div>
        )}

        <p className="modal-field-hint" data-invalid={Boolean(trimmedName) && (!nameValid || collides)}>
          {hint()}
        </p>
        {rootSaved && <p className="modal-field-hint">Saved as your default projects folder.</p>}
        {error && <div className="modal-error">{error}</div>}
      </div>

      <div className="modal-actions">
        <button className="btn-ghost" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn-primary modal-primary-cta"
          data-testid="aw-scaffold-it"
          onClick={() => void submit()}
          disabled={!canSubmit}
        >
          <Icon name="Sparkles" size={13} />
          {busy ? "Starting…" : "Scaffold it"}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Which agent runs the scaffold session. Read from the persisted UI pref, the
 * same source NewSessionModal defaults its picker to — these doors deliberately
 * do NOT show a picker, because each asks exactly one question.
 */
function preferredHarness(): HarnessKind {
  return loadUiPrefs().preferredHarness ?? "claude-code";
}

/** `/a/b/` → `/a/b`, so a user's trailing slash never breaks a path comparison. */
function stripTrailingSlash(input: string): string {
  return input.length > 1 ? input.replace(/\/+$/, "") : input;
}
