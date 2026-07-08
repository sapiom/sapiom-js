import { useState } from "react";
import type { JSX } from "react";
import type { HarnessKind } from "@shared/types";

import type { FsListResponse } from "../lib/api";
import { DirectoryPicker } from "./DirectoryPicker";

interface NewSessionModalProps {
  recentDirs: string[];
  launchDir: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  onClose: () => void;
  onCreate: (cwd: string, harness: HarnessKind) => Promise<void>;
}

const HARNESS_OPTIONS: { id: HarnessKind; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

export function NewSessionModal({
  recentDirs,
  launchDir,
  listDir,
  onClose,
  onCreate,
}: NewSessionModalProps): JSX.Element {
  const [cwd, setCwd] = useState(launchDir ?? recentDirs[0] ?? "");
  const [harness, setHarness] = useState<HarnessKind>("claude-code");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-new-session" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">New session</div>

        <label className="modal-label" htmlFor="new-session-cwd">
          Directory
        </label>
        <DirectoryPicker
          value={cwd}
          onChange={setCwd}
          onSubmit={() => void submit()}
          recentDirs={recentDirs}
          listDir={listDir}
        />

        <div className="modal-label">Harness</div>
        <div className="harness-picker">
          {HARNESS_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={"harness-option" + (harness === option.id ? " is-selected" : "")}
              onClick={() => setHarness(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy || !cwd.trim()}>
            {busy ? "Starting…" : "Start session"}
          </button>
        </div>
      </div>
    </div>
  );
}
