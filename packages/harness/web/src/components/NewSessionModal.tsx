import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import type { HarnessEntry, HarnessKind } from "@shared/types";
import { SPAWNABLE_HARNESS_KINDS } from "@shared/types";

import type { FsListResponse } from "../lib/api";
import {
  FALLBACK_HARNESSES,
  harnessLabel,
  isHarnessSelectable,
  orderHarnesses,
} from "../lib/harness-registry";
import { track } from "../lib/track";
import { loadUiPrefs } from "../lib/ui-prefs";
import { useDismissable } from "../lib/use-dismissable";
import { AnchoredPopover } from "./AnchoredPopover";
import { DirectoryPicker } from "./DirectoryPicker";
import { HarnessBrandIcon } from "./HarnessBrandIcon";
import { HarnessMenuItems } from "./HarnessMenuItems";
import { Icon } from "./Icon";

interface NewSessionModalProps {
  recentDirs: string[];
  launchDir: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  onClose: () => void;
  onCreate: (cwd: string, harness: HarnessKind) => Promise<void>;
  /** Adapter registry fetch (GET /api/harnesses) — when provided, the
   *  harness picker renders from the live registry (installed/experimental/
   *  external flags) instead of the hardcoded fallback pair. */
  listHarnesses?: () => Promise<HarnessEntry[]>;
  /** The button that opened the modal — Escape returns focus to it. */
  triggerRef?: RefObject<HTMLElement | null>;
  /** The dialog's fixed intent — the entry point decides it (creation IA):
   *  "session" (default) starts an agent in the picked
   *  directory; "workspace" registers an existing agent project. No mode
   *  switch — the rail's + adds projects, the header's + starts sessions. */
  mode?: "session" | "workspace";
  /** Project registration handler (workspace mode). */
  onConnect?: (cwd: string) => Promise<void>;
  /** Starts a session at a not-yet-existing folder and asks the agent
   *  to scaffold an agent project there — the action the old "go ask the
   *  agent" hint only described. */
  onScaffold?: (cwd: string, harness: HarnessKind) => Promise<void>;
  /** Bulk discovery — scans the picked folder for agent projects and
   *  registers them all; resolves to how many were found. */
  onScan?: (root: string) => Promise<number>;
  /** Templates journey v0: hands off to the templates dialog (workspace mode
   *  only — a template CREATES the project this dialog would register). */
  onBrowseTemplates?: () => void;
}

/**
 * The per-agent Sapiom MCP setup prompts (HarnessEntry.
 * installMcpPrompt) as copyable blocks — "add Sapiom to the project you
 * already have" lives in the Project tab, so this is its help state.
 */
function McpInstallBlock({ entries }: { entries: HarnessEntry[] }): JSX.Element | null {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const withPrompts = entries.filter((entry) => entry.installMcpPrompt.trim().length > 0);
  if (withPrompts.length === 0) return null;

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
    <div className="mcp-install" data-testid="mcp-install">
      <div className="mcp-install-title">Project not on Sapiom yet?</div>
      <p className="mcp-install-hint">
        Copy the setup prompt for your agent and paste it into a session there. It configures the
        Sapiom MCP server so the agent can build workflows.
      </p>
      <div className="mcp-install-actions">
        {withPrompts.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="btn-ghost mcp-install-copy"
            data-testid={`mcp-install-copy-${entry.id}`}
            onClick={() => copy(entry)}
          >
            {(SPAWNABLE_HARNESS_KINDS as readonly string[]).includes(entry.id) && (
              <HarnessBrandIcon kind={entry.id as HarnessKind} size={13} />
            )}
            {copiedId === entry.id ? "Copied" : `Copy for ${entry.label}`}
          </button>
        ))}
      </div>
    </div>
  );
}

export function NewSessionModal({
  recentDirs,
  launchDir,
  listDir,
  onClose,
  onCreate,
  listHarnesses,
  triggerRef,
  mode: initialMode = "session",
  onConnect,
  onScaffold,
  onScan,
  onBrowseTemplates,
}: NewSessionModalProps): JSX.Element {
  // The entry point fixes the intent (creation IA): the rail's +
  // adds projects, the main header's + (and a workspace row's +) starts
  // sessions. No mode tabs — two intents never share one ambiguous surface.
  const isWorkspace = initialMode === "workspace";
  const [cwd, setCwd] = useState(launchDir ?? recentDirs[0] ?? "");
  // Default agent: the composer's provider dropdown persists what NEW
  // sessions should run (ui-prefs); the registry effect below still corrects
  // an uninstalled/unselectable default.
  const [harness, setHarness] = useState<HarnessKind>(() => loadUiPrefs().preferredHarness ?? "claude-code");
  const [entries, setEntries] = useState<HarnessEntry[]>(FALLBACK_HARNESSES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The picker reports when the typed tail names a directory that doesn't
  // exist yet — fine for a session (the server creates it), never valid for
  // registering an existing project.
  const [newDirTyped, setNewDirTyped] = useState(false);

  // The harness picker floats OUT of the dialog (AnchoredPopover portals to
  // body), so the dialog's own light-dismiss suspends while it's open —
  // Escape and outside clicks then close the innermost layer only.
  const [pickerOpen, setPickerOpen] = useState(false);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const harnessTriggerRef = useRef<HTMLButtonElement>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  useDismissable(!pickerOpen, { onDismiss: onClose, containerRef: panelRef, triggerRef });

  // Consume the adapter registry when the dialog opens. On failure the
  // hardcoded fallback pair stays in place, so demo mode is unchanged.
  useEffect(() => {
    if (!listHarnesses) return;
    let cancelled = false;
    listHarnesses()
      .then((registry) => {
        if (cancelled || registry.length === 0) return;
        setEntries(orderHarnesses(registry));
        const selectable = registry.filter(isHarnessSelectable);
        // Never leave an uninstalled/external adapter selected.
        setHarness((current) =>
          selectable.some((entry) => entry.id === current)
            ? current
            : ((selectable[0]?.id as HarnessKind | undefined) ?? current),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [listHarnesses]);

  const submit = async (): Promise<void> => {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      if (isWorkspace && onConnect) await onConnect(trimmed);
      else await onCreate(trimmed, harness);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // The idea-to-agent path — start a session at the typed (new)
  // folder and hand the agent a scaffold prompt in one click.
  const scaffold = async (): Promise<void> => {
    const trimmed = cwd.trim();
    if (!trimmed || !onScaffold) return;
    setBusy(true);
    setError(null);
    try {
      await onScaffold(trimmed, harness);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Bulk discovery under the picked folder. Found agents close the
  // dialog (they just joined the rail); zero keeps it open to adjust the path.
  const scan = async (): Promise<void> => {
    const trimmed = cwd.trim();
    if (!trimmed || !onScan) return;
    setBusy(true);
    setError(null);
    try {
      const found = await onScan(trimmed);
      if (found > 0) onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        className={"modal " + (isWorkspace ? "modal-add-workspace" : "modal-new-session")}
        role="dialog"
        aria-label={isWorkspace ? "Add project" : "New session"}
        ref={panelRef}
      >
        {/* Full-bleed dialog anatomy: hairline-separated header / body /
            footer blocks, no floating inner boxes — mirrors the design
            system's DialogSurface (.sapiom-dialog). */}
        <div className="modal-header">
          {isWorkspace ? "Add project" : "New session"}
          <button
            className="theme-toggle modal-close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            disabled={busy}
          >
            <Icon name="X" size={14} />
          </button>
        </div>

        <div className="modal-body">
          <section className="modal-section">
            <DirectoryPicker
              value={cwd}
              onChange={setCwd}
              onSubmit={() => void submit()}
              recentDirs={recentDirs}
              listDir={listDir}
              onNewDirChange={setNewDirTyped}
            />
          </section>
          {/* The one field is a DIRECTORY, not a name — say so, and say what
              the name will be, so nobody types a session title into a path. */}
          <p className="modal-field-hint">
            {isWorkspace
              ? newDirTyped
                ? "This folder doesn't exist yet. Add an existing agent project instead, or scaffold a new one here:"
                : "Pick a folder that already contains an agent project (sapiom.json); its workflow joins the rail."
              : "Pick the project directory the agent runs in; the session is named after the folder."}
          </p>
          {/* The hint's "ask the agent to scaffold one" is an ACTION —
              one click starts the session and hands the agent the scaffold
              prompt. */}
          {isWorkspace && newDirTyped && onScaffold && (
            <button
              type="button"
              className="btn-ghost modal-scaffold-cta"
              data-testid="modal-scaffold-cta"
              disabled={busy || !cwd.trim()}
              onClick={() => void scaffold()}
            >
              <Icon name="Sparkles" size={13} />
              {busy ? "Starting…" : "Start a session here and scaffold an agent"}
            </button>
          )}
          {/* Templates journey v0: registering assumes the project exists —
              this is the branch for "I don't have one yet". */}
          {isWorkspace && onBrowseTemplates && (
            <button
              type="button"
              className="btn-ghost modal-templates-cta"
              data-testid="modal-browse-templates"
              disabled={busy}
              onClick={onBrowseTemplates}
            >
              <Icon name="LayoutTemplate" size={13} />
              Start from a template
            </button>
          )}
          {isWorkspace && <McpInstallBlock entries={entries} />}
          {error && <div className="modal-error">{error}</div>}
        </div>

        <div className="modal-actions">
          {!isWorkspace && (
            <>
              {/* Same dropdown recipe as the composer's provider control:
                  [brand icon][label][caret] trigger, registry-driven rows,
                  the active pick marked by its leading check only. */}
              <button
                ref={harnessTriggerRef}
                type="button"
                className="harness-select"
                data-testid="harness-select"
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                aria-label="Agent for this session"
                data-tooltip="Which coding agent runs this session"
                disabled={busy}
                onClick={() => setPickerOpen((v) => !v)}
              >
                <HarnessBrandIcon kind={harness} size={14} />
                <span className="harness-select-label">{harnessLabel(entries, harness)}</span>
                <span className={"disclosure-caret" + (pickerOpen ? " is-open" : "")} aria-hidden="true">
                  <Icon name="ChevronDown" size={12} />
                </span>
              </button>
              <AnchoredPopover
                open={pickerOpen}
                anchorRef={harnessTriggerRef}
                onDismiss={closePicker}
                placement="up-start"
                className="session-menu harness-select-menu"
                role="menu"
                testid="harness-select-menu"
              >
                {/* CLI adapters ONLY — deliberately different from the
                    composer's provider menu, which leads with the native
                    "Sapiom Harness" chat row. A session IS a CLI process,
                    so the native chat mode is not a thing this picker could
                    launch; listing it here would create unstartable rows. */}
                <HarnessMenuItems
                  entries={entries}
                  activeId={harness}
                  testidPrefix="harness-option"
                  onPick={(kind) => {
                    setHarness(kind);
                    closePicker();
                  }}
                />
              </AnchoredPopover>
            </>
          )}
          {isWorkspace && onScan && (
            <button
              type="button"
              className="btn-ghost modal-scan-btn"
              data-testid="modal-scan-btn"
              disabled={busy || !cwd.trim() || newDirTyped}
              title="Find every agent project (sapiom.json) under this folder and add them all"
              onClick={() => void scan()}
            >
              <Icon name="Search" size={13} />
              {busy ? "Scanning…" : "Scan folder for agents"}
            </button>
          )}
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary modal-primary-cta"
            onClick={() => void submit()}
            disabled={busy || !cwd.trim() || (isWorkspace && newDirTyped)}
          >
            {isWorkspace ? (busy ? "Adding…" : "Add project") : busy ? "Starting…" : "Start session"}
          </button>
        </div>
      </div>
    </div>
  );
}
