import { useState } from "react";
import type { JSX } from "react";
import type { HarnessKind } from "@shared/types";

interface NewSessionModalProps {
  recentDirs: string[];
  onClose: () => void;
  onCreate: (cwd: string, harness: HarnessKind) => Promise<void>;
}

const HARNESS_OPTIONS: { id: HarnessKind; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

export function NewSessionModal({ recentDirs, onClose, onCreate }: NewSessionModalProps): JSX.Element {
  const [cwd, setCwd] = useState(recentDirs[0] ?? "");
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">New session</div>

        <label className="modal-label" htmlFor="new-session-cwd">
          Directory
        </label>
        <input
          id="new-session-cwd"
          autoFocus
          className="modal-input"
          list="recent-dirs"
          value={cwd}
          placeholder="/path/to/project"
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
        <datalist id="recent-dirs">
          {recentDirs.map((dir) => (
            <option key={dir} value={dir} />
          ))}
        </datalist>
        {recentDirs.length > 0 && (
          <div className="recent-dirs">
            {recentDirs.map((dir) => (
              <button key={dir} type="button" className="recent-dir-chip" onClick={() => setCwd(dir)}>
                {dir}
              </button>
            ))}
          </div>
        )}

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
