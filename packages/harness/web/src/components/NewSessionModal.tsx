import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import type { HarnessEntry, HarnessKind } from "@shared/types";

import type { FsListResponse } from "../lib/api";
import {
  FALLBACK_HARNESSES,
  harnessLabel,
  isHarnessSelectable,
  orderHarnesses,
} from "../lib/harness-registry";
import { loadUiPrefs } from "../lib/ui-prefs";
import { useDismissable } from "../lib/use-dismissable";
import { AnchoredPopover } from "./AnchoredPopover";
import { FolderBrowser } from "./FolderBrowser";
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
}

export function NewSessionModal({
  recentDirs,
  launchDir,
  listDir,
  onClose,
  onCreate,
  listHarnesses,
  triggerRef,
}: NewSessionModalProps): JSX.Element {
  const [cwd, setCwd] = useState(launchDir ?? recentDirs[0] ?? "");
  // Default agent: the composer's provider dropdown persists what NEW
  // sessions should run (ui-prefs); the registry effect below still corrects
  // an uninstalled/unselectable default.
  const [harness, setHarness] = useState<HarnessKind>(() => loadUiPrefs().preferredHarness ?? "claude-code");
  const [entries, setEntries] = useState<HarnessEntry[]>(FALLBACK_HARNESSES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await onCreate(trimmed, harness);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal modal-new-session"
        role="dialog"
        aria-label="New session"
        ref={panelRef}
      >
        {/* Full-bleed dialog anatomy: hairline-separated header / body /
            footer blocks, no floating inner boxes — mirrors the design
            system's DialogSurface (.sapiom-dialog). */}
        <div className="modal-header">
          New session
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
            <FolderBrowser
              value={cwd}
              onChange={setCwd}
              onOpen={() => void submit()}
              recentDirs={recentDirs}
              listDir={listDir}
            />
          </section>
          {/* The one field is a DIRECTORY, not a name — say so, and say what
              the name will be, so nobody types a session title into a path. */}
          <p className="modal-field-hint">
            Pick the workspace folder the agent runs in; the session is named after the folder.
          </p>
          {error && <div className="modal-error">{error}</div>}
        </div>

        <div className="modal-actions">
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
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary modal-primary-cta"
            onClick={() => void submit()}
            disabled={busy || !cwd.trim()}
          >
            {busy ? "Starting…" : "Start session"}
          </button>
        </div>
      </div>
    </div>
  );
}
