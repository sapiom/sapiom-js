/**
 * ImageComposer — wraps the session pane with image-attach affordances so a
 * user can send a screenshot to the agent via file picker, clipboard paste, or
 * drag-and-drop.
 *
 * There is no rich text pipeline for images in the harness — the terminal IS
 * the input — so an attached image is relayed the way a CLI agent actually
 * consumes one: the server writes it into the project directory and injects
 * its path into the pty (see POST /api/sessions/:id/image). This component
 * owns only the pre-send UX: a client-side queue with thumbnails and
 * remove-before-send, size/type pre-flight, and the three ingest surfaces.
 * It renders the attach UI only when the active session's harness declares
 * image support (GET /api/harnesses) — against the harness-launch server
 * (eebb95c), which predates the endpoint, the field is absent and the whole
 * affordance self-hides. The queue is session-scoped so a paste or drop
 * always lands on the active session's queue.
 */
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, JSX, ReactNode } from "react";
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
  type HarnessEntry,
  type HarnessKind,
} from "@shared/types";
import { ApiError, type HarnessApi } from "../lib/api";
import { Icon } from "./Icon";

/**
 * Opens the composer's file picker from anywhere inside the wrapped session
 * pane (the session toolbar's attach button). Null when no ImageComposer wraps the
 * consumer OR the session's harness lacks image support — consumers hide
 * their affordance then instead of rendering a dead control.
 */
export const ImageAttachContext = createContext<(() => void) | null>(null);

export interface ImageComposerProps {
  sessionId: string;
  /** The active session's harness — gates the attach UI on its image support. */
  harness: HarnessKind;
  api: HarnessApi;
  /** Push a user-facing message (failures), same slot as skills/macros. */
  showToast: (message: string) => void;
  /** The session pane this composer wraps. */
  children: ReactNode;
}

interface QueuedImage {
  id: string;
  /** `data:<mediaType>;base64,...` — sent verbatim to the server. */
  dataUrl: string;
  filename: string;
  mediaType: string;
  bytes: number;
}

const humanBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.readAsDataURL(file);
  });

export const ImageComposer = ({ sessionId, harness, api, showToast, children }: ImageComposerProps): JSX.Element => {
  const [entries, setEntries] = useState<HarnessEntry[] | null>(null);
  const [queued, setQueued] = useState<QueuedImage[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Depth counter: dragenter/dragleave fire per child element, so a naive
  // boolean flickers off when the pointer crosses an inner node. Counting keeps
  // the overlay up until the drag truly leaves the pane.
  const dragDepth = useRef(0);

  // Fetch the adapter registry once; capability is derived per-harness below so
  // switching sessions never refetches. A failed fetch leaves `entries` null →
  // we optimistically allow attach (the server is the real gate).
  useEffect(() => {
    let cancelled = false;
    api
      .listHarnesses()
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {
        /* leave entries null — attach stays available; server enforces support */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const imageSupported = useMemo(() => {
    if (!entries) return true; // optimistic until the registry loads
    // No matching registry entry reads as unsupported, so the affordance never
    // dangles without a route.
    return entries.find((e) => e.id === harness)?.imageInput ?? false;
  }, [entries, harness]);

  // Never carry a queued image from one session into the next.
  useEffect(() => {
    setQueued([]);
    dragDepth.current = 0;
    setDragActive(false);
  }, [sessionId]);

  const enqueueFiles = useCallback(
    async (files: File[]): Promise<void> => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      const accepted: QueuedImage[] = [];
      for (const file of images) {
        if (!(ALLOWED_IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type)) {
          showToast(`${file.name || "image"}: ${file.type} isn't a supported image type.`);
          continue;
        }
        if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
          showToast(`${file.name || "image"} is ${humanBytes(file.size)}, over the ${humanBytes(MAX_IMAGE_UPLOAD_BYTES)} limit.`);
          continue;
        }
        try {
          const dataUrl = await readAsDataUrl(file);
          accepted.push({
            id: crypto.randomUUID(),
            dataUrl,
            filename: file.name || "pasted-image",
            mediaType: file.type,
            bytes: file.size,
          });
        } catch {
          showToast(`Could not read ${file.name || "image"}.`);
        }
      }
      if (accepted.length > 0) setQueued((prev) => [...prev, ...accepted]);
    },
    [showToast],
  );

  // Clipboard paste: only intercept when the clipboard actually carries an
  // image, so ordinary text paste still flows through to the terminal.
  // Bound to the window because the focused element is xterm's hidden textarea.
  useEffect(() => {
    if (!imageSupported) return;
    const onPaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;
      // DataTransferItemList is array-like but not reliably iterable — index it.
      const files: File[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length === 0) return; // not an image paste — leave it for the pane
      e.preventDefault();
      void enqueueFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [imageSupported, enqueueFiles]);

  const removeQueued = useCallback((id: string): void => {
    setQueued((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const sendQueued = useCallback(async (): Promise<void> => {
    if (queued.length === 0 || sending) return;
    setSending(true);
    let failure: string | null = null;
    for (const img of queued) {
      try {
        await api.attachImage(sessionId, { dataUrl: img.dataUrl, filename: img.filename });
        setQueued((prev) => prev.filter((q) => q.id !== img.id));
      } catch (err) {
        failure = err instanceof ApiError && err.reason ? err.reason : (err as Error).message;
        break; // stop on first failure; unsent images stay queued for retry
      }
    }
    setSending(false);
    // Only surface a toast on failure — a successful send is self-evident: the
    // paths land in the terminal input and the thumbnails clear.
    if (failure) showToast(failure);
  }, [queued, sending, api, sessionId, showToast]);

  const onDragEnter = useCallback((e: DragEvent<HTMLDivElement>): void => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepth.current += 1;
    setDragActive(true);
  }, []);

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>): void => {
    if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
  }, []);

  const onDragLeave = useCallback((): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>): void => {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);
      void enqueueFiles(Array.from(e.dataTransfer.files));
    },
    [enqueueFiles],
  );

  const openPicker = useCallback((): void => {
    fileInputRef.current?.click();
  }, []);

  // Harness can't take images — render just the session pane, no attach surface.
  if (!imageSupported) return <>{children}</>;

  return (
    <div
      className="image-composer"
      data-testid="image-composer"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ImageAttachContext.Provider value={openPicker}>
        <div className="image-composer-pane">{children}</div>
      </ImageAttachContext.Provider>

      {dragActive && (
        <div className="image-composer-dropzone" data-testid="image-composer-dropzone">
          <Icon name="ImageUp" size={28} />
          <span>Drop an image to attach it</span>
        </div>
      )}

      {/* The queue strip appears only once something is queued — paste
          and drag-drop feed the queue. No standalone attach button. */}
      {queued.length > 0 && (
        <div className="image-composer-bar">
          <ul className="image-composer-thumbs" data-testid="image-composer-thumbs">
            {queued.map((img) => (
              <li key={img.id} className="image-composer-thumb" title={`${img.filename} · ${humanBytes(img.bytes)}`}>
                <img src={img.dataUrl} alt={img.filename} />
                <button
                  type="button"
                  className="image-composer-thumb-remove"
                  onClick={() => removeQueued(img.id)}
                  disabled={sending}
                  aria-label={`Remove ${img.filename}`}
                  data-tooltip={`Remove ${img.filename}`}
                  data-testid="image-composer-thumb-remove"
                >
                  <Icon name="X" size={11} />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="image-composer-send btn-primary"
            onClick={() => void sendQueued()}
            disabled={sending}
            data-testid="image-composer-send"
          >
            {sending ? "Sending…" : `Send ${queued.length} to agent`}
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="image-composer-file-input"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          void enqueueFiles(files);
          e.target.value = ""; // allow re-picking the same file
        }}
      />
    </div>
  );
};
