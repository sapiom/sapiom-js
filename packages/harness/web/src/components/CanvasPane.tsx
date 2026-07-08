import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { BusMessage } from "@shared/types";

import { isMockMode } from "../lib/api";
import { Icon } from "./Icon";

type CanvasMode = "generated" | "preview";

interface CanvasPaneProps {
  sessionId: string | null;
  lastMessage: BusMessage | null;
}

export function CanvasPane({ sessionId, lastMessage }: CanvasPaneProps): JSX.Element {
  const [mode, setMode] = useState<CanvasMode>("generated");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewInput, setPreviewInput] = useState("");
  const [hasGeneratedContent, setHasGeneratedContent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [portChip, setPortChip] = useState<{ port: number; url: string } | null>(null);

  // Probe once per session for pre-existing content — the agent may have written
  // it in an earlier turn, before this pane was around to catch a reload event.
  useEffect(() => {
    setHasGeneratedContent(false);
    setPortChip(null);
    if (!sessionId || isMockMode()) return;
    let cancelled = false;
    fetch(`/canvas/${sessionId}/`, { method: "HEAD" })
      .then((res) => !cancelled && setHasGeneratedContent(res.ok))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!lastMessage || !sessionId) return;
    if (lastMessage.type === "canvas.reload" && lastMessage.harnessSessionId === sessionId) {
      setHasGeneratedContent(true);
      setReloadKey((key) => key + 1);
    } else if (lastMessage.type === "port.detected" && lastMessage.harnessSessionId === sessionId) {
      setPortChip({ port: lastMessage.port, url: lastMessage.url });
    }
  }, [lastMessage, sessionId]);

  const openPreviewChip = (): void => {
    if (!portChip) return;
    setPreviewUrl(portChip.url);
    setPreviewInput(portChip.url);
    setMode("preview");
  };

  const navigatePreview = (): void => setPreviewUrl(previewInput);

  return (
    <aside className="canvas-pane">
      <div className="canvas-header">
        <div className="canvas-mode-toggle">
          <button
            className={"canvas-mode-btn" + (mode === "generated" ? " is-active" : "")}
            onClick={() => setMode("generated")}
          >
            Generated
          </button>
          <button
            className={"canvas-mode-btn" + (mode === "preview" ? " is-active" : "")}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
        </div>
        {portChip && mode !== "preview" && (
          <button className="preview-chip" onClick={openPreviewChip}>
            <Icon name="Radio" size={12} /> Preview :{portChip.port}
          </button>
        )}
      </div>

      {mode === "preview" ? (
        <div className="canvas-preview">
          <div className="canvas-urlbar">
            <input
              className="canvas-url-input"
              value={previewInput}
              placeholder="http://localhost:3000"
              onChange={(e) => setPreviewInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && navigatePreview()}
            />
            <button className="btn-ghost" onClick={navigatePreview}>
              Go
            </button>
          </div>
          {previewUrl ? (
            <iframe
              key={previewUrl}
              className="canvas-iframe"
              src={previewUrl}
              sandbox="allow-scripts allow-forms allow-same-origin"
            />
          ) : (
            <div className="canvas-empty">Enter a localhost URL to preview a running dev server.</div>
          )}
        </div>
      ) : !sessionId ? (
        <div className="canvas-empty">Start a session to see its canvas here.</div>
      ) : !hasGeneratedContent ? (
        <div className="canvas-empty">
          <p>Nothing rendered yet.</p>
          <p>
            Ask your agent to write HTML to <code>.sapiom/canvas/index.html</code> — this pane hot-reloads whenever
            it changes.
          </p>
        </div>
      ) : (
        <iframe key={reloadKey} className="canvas-iframe" src={`/canvas/${sessionId}/`} sandbox="allow-scripts" />
      )}
    </aside>
  );
}
