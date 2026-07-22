/**
 * Composer (draft1's sapiom-composer pattern): brand ring on focus-within,
 * Enter sends, Shift+Enter breaks the line, IME-safe, disabled while empty.
 * ONE button that morphs Send to Stop while pending — form submit routes to
 * onStop then, and Enter deliberately does nothing so a reflexive keystroke
 * can never kill a draft in progress.
 *
 * Toolbar anatomy (creation verbs left, session facts right): the + attach
 * and the prompt library lead the row; the provider dropdown and Send anchor
 * the right. The + drives the SAME queue the pane-level ImageComposer owns
 * (paste and drag-drop land there too) and is the ONE attach entry — no
 * duplicate button elsewhere. No harness image support: no + button.
 */
import { useContext, useRef, type JSX, type KeyboardEvent } from "react";
import type { HarnessEntry, HarnessKind, MacroDef } from "@shared/types";

import type { SkillMeta } from "../../lib/api";
import { ImageAttachContext } from "../ImageComposer";
import { Icon } from "../Icon";
import { ComposerLibrary } from "./ComposerLibrary";
import { ComposerProvider } from "./ComposerProvider";

export interface ComposerProps {
  value: string;
  pending: boolean;
  /** The session's pinned agent — rendered as a static label, not a dead
   *  select: this session's kind cannot change after launch. */
  harness: HarnessKind;
  macros: MacroDef[];
  listSkills(): Promise<SkillMeta[]>;
  /** Adapter registry fetch — the provider dropdown renders from it. */
  listHarnesses?(): Promise<HarnessEntry[]>;
  onChange(next: string): void;
  onSubmit(text: string): void;
  onStop(): void;
}

export const Composer = ({
  value,
  pending,
  harness,
  macros,
  listSkills,
  listHarnesses,
  onChange,
  onSubmit,
  onStop,
}: ComposerProps): JSX.Element => {
  const canSend = value.trim().length > 0;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openAttach = useContext(ImageAttachContext);

  const send = (): void => {
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!pending) send();
  };

  // Library templates land at the draft's end on their own line; focus goes
  // straight back so the user keeps typing without an extra click.
  const insertTemplate = (template: string): void => {
    onChange(value.trim().length > 0 ? `${value.replace(/\s+$/, "")}\n${template}` : template);
    inputRef.current?.focus();
  };

  return (
    <form
      className="chat-composer-wrap"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) onStop();
        else send();
      }}
    >
      <div className="chat-composer">
        <textarea
          ref={inputRef}
          className="chat-composer-input"
          data-testid="chat-input"
          rows={2}
          placeholder="Describe the outcome you want"
          aria-label="Message the session agent"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="chat-composer-toolbar">
          {/* Left cluster, creation verbs first: + attach (the ONE attach
              entry), then the library. Rendered only when the session's
              harness takes images — a + that opened nothing would be a dead
              control. */}
          {openAttach && (
            <button
              type="button"
              className="composer-icon-btn"
              data-testid="composer-attach"
              aria-label="Attach an image"
              data-tooltip="Attach an image (or paste / drag-drop onto the pane)"
              onClick={openAttach}
            >
              <Icon name="Plus" size={15} />
            </button>
          )}
          <ComposerLibrary macros={macros} listSkills={listSkills} onInsert={insertTemplate} />
          {/* Right cluster, session facts: the provider dropdown, then Send. */}
          <ComposerProvider harness={harness} listHarnesses={listHarnesses} />
          <button
            type="submit"
            className="chat-composer-submit"
            data-testid="chat-submit"
            data-pending={pending || undefined}
            disabled={!pending && !canSend}
            aria-label={pending ? "Stop drafting" : "Send message"}
            data-tooltip={pending ? "Stop drafting" : "Send message"}
          >
            <Icon name={pending ? "Square" : "ArrowUp"} size={15} />
          </button>
        </div>
      </div>
      <p className="chat-composer-note">
        Studio proposes draft changes. Paid execution and deploys always need an explicit action.
      </p>
    </form>
  );
};
