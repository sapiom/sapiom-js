import { useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";

import type { FsListResponse } from "../lib/api";
import { getDesktopBridge } from "../lib/desktop";
import { middleTruncatePath, parentOf } from "../lib/paths";
import { Icon } from "./Icon";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

interface FolderFieldProps {
  value: string;
  onChange: (path: string) => void;
  /** Enter in the field confirms the host dialog's primary action. */
  onSubmit: () => void;
  /** Recently used folders, offered as chips. An empty list hides the row. */
  recentDirs: string[];
  /** Backs the browser host's completion. Unused on desktop — the OS dialog is
   *  the completion there. */
  listDir: (path?: string) => Promise<FsListResponse>;
}

/**
 * ONE folder field, and no file browser of our own.
 *
 * This replaces `DirectoryPicker`, which built a path bar, an up-one-level
 * button and a scrolling folder list in-app. That was a worse file browser than
 * the one every user already has — no favourites, no search, no keyboard
 * navigation, no drag target, no network volumes — and it was ours to keep in
 * sync forever.
 *
 * **Desktop:** `chooseDirectory` opens the OS folder browser
 * (`harness-desktop/src/main/dialogs.ts`), which is the real thing.
 *
 * **The `npx` browser host:** there is no native dialog, so the fallback is the
 * smallest one that keeps the feature — the field itself, plus a native
 * `<datalist>` of the current folder's children. That is browser chrome, not
 * ours: it costs one listing and no layout, and it is the reason a browser user
 * can still find a folder by typing rather than reciting an absolute path.
 *
 * The bridge is feature-detected rather than assumed (see `lib/desktop.ts`): an
 * older desktop build without `chooseDirectory` reads as a browser and gets the
 * fallback, which is always safe.
 */
export function FolderField({
  value,
  onChange,
  onSubmit,
  recentDirs,
  listDir,
}: FolderFieldProps): JSX.Element {
  const listId = useId();
  const [options, setOptions] = useState<string[]>([]);

  const chooseDirectory = getDesktopBridge()?.chooseDirectory ?? null;

  // Which edges of the chip row are clipped by scroll — drives the fade masks
  // so an overflowing row never hard-clips a chip without saying "there's more".
  const chipsRef = useRef<HTMLDivElement>(null);
  const [chipsFade, setChipsFade] = useState<"none" | "left" | "right" | "both">("none");
  const updateChipsFade = (): void => {
    const el = chipsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setChipsFade(left && right ? "both" : left ? "left" : right ? "right" : "none");
  };
  useEffect(() => {
    updateChipsFade();
  }, [recentDirs]);

  // Completion options for the browser fallback only. Failures are silent: a
  // datalist with nothing in it is a field with no suggestions, and the host
  // dialog is what reports an unreadable folder.
  useEffect(() => {
    if (chooseDirectory) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      // The real server 404s a path that does not exist yet, so a half-typed
      // tail falls back to its nearest existing ancestor — which is exactly the
      // listing that can complete it.
      const up = parentOf(value);
      listDir(value || undefined)
        .catch(() => (up ? listDir(up) : Promise.reject(new Error("no parent"))))
        .then((res) => {
          if (!cancelled) setOptions(res.dirs.map((dir) => dir.path));
        })
        .catch(() => {
          if (!cancelled) setOptions([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [value, listDir, chooseDirectory]);

  const chooseNatively = (): void => {
    if (!chooseDirectory) return;
    void chooseDirectory(value || undefined)
      .then((picked) => {
        if (picked) onChange(picked);
      })
      .catch(() => {
        /* a cancelled or failed native pick leaves the field as-is */
      });
  };

  return (
    <div className="folder-field">
      <div className="folder-field-row">
        <input
          id="new-session-cwd"
          autoFocus
          aria-label="Folder"
          className="modal-input folder-field-input"
          data-testid="folder-field-input"
          value={value}
          placeholder="/path/to/folder"
          list={chooseDirectory ? undefined : listId}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            onSubmit();
          }}
        />
        {chooseDirectory && (
          <button
            type="button"
            className="btn-line folder-field-choose"
            data-testid="folder-field-choose"
            onClick={chooseNatively}
          >
            <Icon name="Folder" size={14} />
            Choose…
          </button>
        )}
      </div>

      {!chooseDirectory && (
        <datalist id={listId} data-testid="folder-field-options">
          {options.map((path) => (
            <option key={path} value={path} />
          ))}
        </datalist>
      )}

      {recentDirs.length > 0 && (
        <div className="recent-dirs" ref={chipsRef} data-fade={chipsFade} onScroll={updateChipsFade}>
          {recentDirs.map((dir) => (
            <button
              key={dir}
              type="button"
              className="recent-dir-chip"
              title={dir}
              onClick={() => onChange(dir)}
              {...trackingAttrs({ object: "directory" })}
            >
              {middleTruncatePath(dir)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
