import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  MAX_INLINE_ATTACHMENTS_TOTAL_BYTES,
  type HarnessEntry,
  type HarnessKind,
  type TemplateListResponse,
} from "@shared/types";

import { errorMessage } from "../lib/api";
import { harnessLabel } from "../lib/harness-registry";
import { formatComplexity, type GalleryTemplate } from "../lib/templates";
import { getDesktopBridge } from "../lib/desktop";
import {
  classifyPaste,
  countWords,
  pastedDocumentName,
  urlLabel,
} from "../lib/composer-intake";
import {
  filesToAttachments,
  mergeAttachments,
  type NewSessionAttachment,
} from "../lib/new-session-attachments";
import { AnchoredPopover } from "./AnchoredPopover";
import { HarnessBrandIcon } from "./HarnessBrandIcon";
import { HarnessMenuItems } from "./HarnessMenuItems";
import { Icon } from "./Icon";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/**
 * THE NEW-AGENT SCREEN (flow-creation.md §4.3). One screen, every entrance.
 *
 * "What should your agent do?", the chips, the idea box and the template row
 * are where creating an agent leads: from a folder you just picked (New
 * project), from a project you already have (the row's New agent, an empty
 * project's name), or from template Use. The project is STATED, in the header
 * chip and above the headline, never chosen here: it was chosen before this
 * screen opened. The screen is mounted only with a project; the no-project
 * home is `NoProjectHome`.
 *
 * Resource intake lives here (§4.6 step 1): files by paperclip, drop or
 * paste; LINKS pasted into the box are listed as sources rather than typed;
 * a LONG paste becomes an attached document rather than a wall of text.
 * Nothing is fetched client-side; the list is handed to the session.
 *
 * Submit is App's (`onSubmitIdea`), handed the idea, the files and the
 * sources. Under §4.4 the harness scaffolds the agent first and a normal
 * session opens on it; that is slice 4 (SAP-3576), and until it lands App
 * runs the pre-existing path, in the stated project. A refusal comes back
 * here as a sentence under the field, and nothing has started.
 */

/** Quick-start prompts. A curated set that PREFILLS the box (editable before
 *  send), not a hidden instant-submit. The label is the chip; the prompt is
 *  what it types. The three chips and their fills are the design's
 *  (design-eng `design-system/src/ftux/content.ts` CHIPS, IA.md creation
 *  section): sentence case, three of them. */
const IDEA_CHIPS: ReadonlyArray<{ label: string; prompt: string }> = [
  {
    label: "Sales outreach",
    prompt:
      "Build a sales agent that finds leads at logistics companies, writes a personalized first line for each, verifies their email, and follows up until someone replies.",
  },
  {
    label: "Support triage",
    prompt:
      "Build an agent that triages my support inbox into queues and drafts first replies.",
  },
  {
    label: "Research digest",
    prompt:
      "Build an agent that watches my competitors and sends a sourced digest every Monday.",
  },
];

/** How many catalog templates the screen surfaces before "Browse all templates". */
const HOME_TEMPLATE_COUNT = 3;

function chipSlug(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "-");
}

interface NewSessionComposerProps {
  /**
   * The project this screen is creating IN. Present from every entrance; the
   * screen states it and never asks for it.
   */
  project: { root: string; label: string };
  /** What the box opens with: a template's idea when Use brought us here. */
  initialIdea?: string;
  harness: HarnessKind;
  entries: HarnessEntry[];
  onHarnessChange: (harness: HarnessKind) => void;
  /** Genuine first run (AppState.firstRun): shows the one-time telemetry
   *  opt-in + docs footer. */
  firstRun: boolean;
  /**
   * Create the agent from this idea and open its first session. Rejects with
   * the sentence to show under the field (a 409 duplicate, a 400 invalid
   * name); on rejection nothing has started and the idea stays in the box.
   */
  onSubmitIdea: (
    idea: string,
    attachments: readonly NewSessionAttachment[],
    sources: readonly string[],
  ) => Promise<void>;
  /** Surface a file-resolution failure in the app's existing toast. */
  onAttachmentError: (message: string) => void;
  /** Start from a catalog template: the template becomes the idea here. */
  onUseTemplate: (template: GalleryTemplate) => void;
  /** Navigate to the full templates catalog. */
  onBrowseTemplates: () => void;
  /** Template catalog fetch. */
  listTemplates: () => Promise<TemplateListResponse>;
  /** First-run telemetry opt-in (SAP-1988): off by default. */
  telemetryOptIn: boolean;
  onToggleTelemetry: (next: boolean) => Promise<void>;
}

export function NewSessionComposer({
  project,
  initialIdea,
  harness,
  entries,
  onHarnessChange,
  firstRun,
  onSubmitIdea,
  onAttachmentError,
  onUseTemplate,
  onBrowseTemplates,
  listTemplates,
  telemetryOptIn,
  onToggleTelemetry,
}: NewSessionComposerProps): JSX.Element {
  const [idea, setIdea] = useState(initialIdea ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [templates, setTemplates] = useState<GalleryTemplate[]>([]);
  const [attachments, setAttachments] = useState<NewSessionAttachment[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // The server's refusal (or a failed start), shown under the field. Cleared
  // on the next edit: a corrected idea is a new question.
  const [submitError, setSubmitError] = useState<string | null>(null);
  // While the composer is dropping away to make room for the terminal. The
  // action (which starts the session) fires once the exit has played.
  const [leaving, setLeaving] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const harnessTriggerRef = useRef<HTMLButtonElement>(null);
  const attachmentsRef = useRef<NewSessionAttachment[]>([]);
  const sourcesRef = useRef<string[]>([]);
  const submittingRef = useRef(false);
  const queueingRef = useRef(false);
  const queueTailRef = useRef<Promise<void>>(Promise.resolve());
  const pendingQueueCountRef = useRef(0);
  const pastedDocumentsRef = useRef(0);
  // Word counts of the documents pasted here, by the file name each was
  // attached under, so the chip can say "Pasted document, 540 words" the way
  // the design does rather than "pasted-1.md".
  const pastedWordsRef = useRef(new Map<string, number>());
  const closePicker = useCallback(() => setPickerOpen(false), []);

  // The first few catalog templates for the starter row. On failure the row
  // simply doesn't render (the box is still the primary path).
  useEffect(() => {
    let cancelled = false;
    listTemplates()
      .then((res) => {
        if (cancelled) return;
        setTemplates(
          res.templates
            .map((template) => ({ ...template, kind: "gallery" as const }))
            .slice(0, HOME_TEMPLATE_COUNT),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [listTemplates]);

  const pickHarness = (kind: HarnessKind): void => {
    onHarnessChange(kind);
    closePicker();
  };

  // Play the drop-away, THEN start the session (the parent swaps in the
  // terminal). The delay is the exit animation's duration.
  const leaveThen = (action: () => void): void => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(action, 170);
  };
  const submit = (): void => {
    if (leaving || submittingRef.current || queueingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setLeaving(true);
    const queuedAttachments = attachmentsRef.current;
    const queuedSources = sourcesRef.current;
    window.setTimeout(() => {
      void onSubmitIdea(idea.trim(), queuedAttachments, queuedSources).catch(
        (err: unknown) => {
          // NOTHING STARTED. The idea, the files and the links are all still
          // here, and the refusal lands under the field that produced it.
          submittingRef.current = false;
          setLeaving(false);
          setSubmitting(false);
          setSubmitError(errorMessage(err, "Couldn't create the agent."));
          textareaRef.current?.focus();
        },
      );
    }, 170);
  };

  const queueFiles = (
    files: readonly File[],
    onFailed?: () => void,
  ): void => {
    if (files.length === 0 || submittingRef.current) return;
    const pathForFile = getDesktopBridge()?.pathForFile;
    pendingQueueCountRef.current += 1;
    queueingRef.current = true;
    setQueueing(true);

    const processFiles = async (): Promise<void> => {
      const usedInlineBytes = attachmentsRef.current.reduce(
        (total, attachment) =>
          total + (attachment.kind === "inline" ? attachment.bytes : 0),
        0,
      );
      const result = await filesToAttachments(
        files,
        pathForFile,
        Math.max(0, MAX_INLINE_ATTACHMENTS_TOTAL_BYTES - usedInlineBytes),
      );
      if (result.attachments.length > 0) {
        const next = mergeAttachments(
          attachmentsRef.current,
          result.attachments,
        );
        attachmentsRef.current = next;
        setAttachments(next);
      }
      if (result.errors.length > 0) {
        onAttachmentError(result.errors.join(" "));
        onFailed?.();
      }
    };

    const task = queueTailRef.current.then(processFiles);
    queueTailRef.current = task.catch(() => {});
    void task
      .catch((error: unknown) => {
        onAttachmentError(
          (error as Error).message || "Couldn't attach those files.",
        );
        onFailed?.();
      })
      .then(() => {
        pendingQueueCountRef.current -= 1;
        if (pendingQueueCountRef.current === 0) {
          queueingRef.current = false;
          setQueueing(false);
        }
      });
  };

  const removeAttachment = (id: string): void => {
    if (submittingRef.current) return;
    const next = attachmentsRef.current.filter((item) => item.id !== id);
    attachmentsRef.current = next;
    setAttachments(next);
  };

  const addSources = (urls: readonly string[]): void => {
    if (submittingRef.current) return;
    const next = [...sourcesRef.current];
    for (const url of urls) if (!next.includes(url)) next.push(url);
    sourcesRef.current = next;
    setSources(next);
  };
  const removeSource = (url: string): void => {
    if (submittingRef.current) return;
    const next = sourcesRef.current.filter((item) => item !== url);
    sourcesRef.current = next;
    setSources(next);
  };

  /**
   * PASTED TEXT goes where it is most useful (§4.6 step 1). Only links: they
   * are sources, listed, not typed. A long paste: a document, attached under a
   * numbered name, not a wall in the box. Anything else types natively.
   */
  const intakePastedText = (text: string): boolean => {
    const intake = classifyPaste(text);
    if (intake.kind === "links") {
      addSources(intake.urls);
      return true;
    }
    if (intake.kind === "document") {
      pastedDocumentsRef.current += 1;
      const name = pastedDocumentName(pastedDocumentsRef.current);
      pastedWordsRef.current.set(name, countWords(text));
      // The paste was consumed on the promise of an attachment. If the
      // conversion refuses it, the words go back into the box.
      queueFiles([new File([text], name, { type: "text/markdown" })], () =>
        setIdea((current) => (current ? `${current}\n\n${text}` : text)),
      );
      return true;
    }
    return false;
  };

  const fileCount = attachments.length;
  const linkCount = sources.length;
  const countLabel = (count: number, noun: string): string =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;
  const attachmentCountLabel =
    fileCount === 0 && linkCount === 0
      ? "No files attached."
      : linkCount === 0
        ? `${countLabel(fileCount, "file")} attached.`
        : fileCount === 0
          ? `${countLabel(linkCount, "link")} attached.`
          : `${countLabel(fileCount, "file")} and ${countLabel(linkCount, "link")} attached.`;
  const attachmentStatus = draggingFiles
    ? "Drop files to attach."
    : submitting
      ? `Creating the agent with ${attachmentCountLabel.toLowerCase()}`
      : queueing
        ? "Preparing attached files."
        : attachmentCountLabel;

  return (
    <div
      className={"composer-home" + (leaving ? " is-leaving" : "")}
      data-testid="new-session-composer"
      {...trackingAttrs({ surface: "composer" })}
    >
      <div className="composer-hero">
        {/* THE PROJECT IS STATED, never chosen (D27, §4.3). Both entrances
            land here and only one of them just picked a folder; arriving from
            the other with no mention of it is how an agent ends up in a folder
            nobody meant. */}
        <p className="composer-greeting" data-testid="composer-greeting">
          <span className="composer-project" data-testid="new-agent-project">
            <Icon name="Folder" size={13} />
            New agent in <strong>{project.label}</strong>
          </span>
        </p>
        <h1 className="composer-heading">What should your agent do?</h1>

        <div className="composer-chips" role="list">
          {IDEA_CHIPS.map((chip) => (
            <button
              key={chip.label}
              type="button"
              role="listitem"
              className="composer-chip"
              data-testid={`composer-chip-${chipSlug(chip.label)}`}
              onClick={() => {
                setIdea(chip.prompt);
                setSubmitError(null);
                textareaRef.current?.focus();
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div
          className={
            "composer-box" +
            (draggingFiles ? " is-dragging-files" : "") +
            (submitting || queueing ? " is-busy" : "") +
            (submitError ? " has-error" : "")
          }
          data-testid="composer-box"
          role="group"
          aria-label="New agent"
          aria-busy={submitting || queueing}
          aria-describedby="composer-attachment-status"
          onPaste={(event) => {
            const itemFiles = Array.from(event.clipboardData.items)
              .filter((item) => item.kind === "file")
              .flatMap((item) => {
                const file = item.getAsFile();
                return file ? [file] : [];
              });
            const files =
              itemFiles.length > 0
                ? itemFiles
                : Array.from(event.clipboardData.files ?? []);
            if (files.length === 0) return;
            event.preventDefault();
            queueFiles(files);
          }}
          onDragEnter={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            if (submittingRef.current) return;
            setDraggingFiles(true);
          }}
          onDragOver={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            if (submittingRef.current) return;
            event.dataTransfer.dropEffect = "copy";
            setDraggingFiles(true);
          }}
          onDragLeave={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && event.currentTarget.contains(next))
              return;
            setDraggingFiles(false);
          }}
          onDrop={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            setDraggingFiles(false);
            queueFiles(Array.from(event.dataTransfer.files));
          }}
        >
          {draggingFiles && (
            <div className="composer-drop-hint" aria-hidden="true">
              <Icon name="CloudUpload" size={18} /> Drop files to attach
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="composer-input"
            data-testid="composer-input"
            placeholder="Describe the outcome you want. Paste links or a document to attach them."
            aria-label="Describe the outcome you want"
            aria-invalid={submitError != null}
            aria-errormessage={submitError ? "new-agent-error" : undefined}
            aria-describedby={
              submitError
                ? "composer-attachment-status new-agent-error"
                : "composer-attachment-status"
            }
            value={idea}
            rows={2}
            autoFocus
            onChange={(event) => {
              setIdea(event.target.value);
              if (submitError) setSubmitError(null);
            }}
            onPaste={(event) => {
              // Files are the box's paste; this is the text half. Links and
              // long pastes are intake; a sentence types as it always did.
              if (event.clipboardData.files.length > 0) return;
              const text = event.clipboardData.getData("text/plain");
              if (!text || !intakePastedText(text)) return;
              event.preventDefault();
            }}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a newline (it's a multi-line outcome).
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {(attachments.length > 0 || sources.length > 0) && (
            <ul
              className="composer-files"
              data-testid="composer-files"
              aria-label="Attached resources"
            >
              {attachments.map((attachment) => {
                // A pasted document is shown as what it is, with its size in
                // words (the design's chip), not as the file name it rides in.
                const pastedWords = pastedWordsRef.current.get(attachment.name);
                return (
                <li
                  key={attachment.id}
                  className="composer-file"
                  data-testid={
                    pastedWords != null ? "composer-source-document" : undefined
                  }
                  {...trackingAttrs({ object: "file" })}
                >
                  <Icon name={pastedWords != null ? "FileText" : "Paperclip"} size={13} />
                  <span className="composer-file-name" title={attachment.name}>
                    {pastedWords != null ? "Pasted document" : attachment.name}
                  </span>
                  {pastedWords != null && (
                    <span className="composer-file-detail">
                      {pastedWords.toLocaleString("en-US")} words
                    </span>
                  )}
                  <button
                    type="button"
                    className="composer-file-remove"
                    aria-label={`Remove ${attachment.name}`}
                    disabled={submitting}
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    <Icon name="X" size={11} />
                  </button>
                </li>
                );
              })}
              {sources.map((url) => (
                <li
                  key={url}
                  className="composer-file composer-source"
                  data-testid="composer-source"
                  {...trackingAttrs({ object: "link" })}
                >
                  <Icon name="Link" size={13} />
                  <span className="composer-file-name" title={url}>
                    {urlLabel(url)}
                  </span>
                  <button
                    type="button"
                    className="composer-file-remove"
                    aria-label={`Remove ${url}`}
                    disabled={submitting}
                    onClick={() => removeSource(url)}
                  >
                    <Icon name="X" size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="composer-box-actions">
            <button
              type="button"
              className="composer-attach"
              data-testid="composer-attach-file"
              aria-label="Attach files"
              data-tooltip="Attach files, or paste links and documents"
              disabled={submitting}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="Paperclip" size={15} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              data-testid="composer-file-input"
              onChange={(event) => {
                queueFiles(
                  event.target.files ? Array.from(event.target.files) : [],
                );
                event.target.value = "";
              }}
            />

            <div className="composer-box-right">
              <button
                ref={harnessTriggerRef}
                type="button"
                className="harness-select composer-harness"
                data-testid="composer-harness-select"
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                aria-label="Coding agent for this session"
                data-tooltip="Which coding agent runs this session"
                onClick={() => setPickerOpen((open) => !open)}
              >
                <HarnessBrandIcon kind={harness} size={14} />
                <span className="harness-select-label">{harnessLabel(entries, harness)}</span>
                <span
                  className={"disclosure-caret" + (pickerOpen ? " is-open" : "")}
                  aria-hidden="true"
                >
                  <Icon name="ChevronDown" size={12} />
                </span>
              </button>
              <AnchoredPopover
                open={pickerOpen}
                anchorRef={harnessTriggerRef}
                onDismiss={closePicker}
                placement="up-end"
                className="session-menu harness-select-menu"
                role="menu"
                testid="composer-harness-menu"
              >
                <HarnessMenuItems
                  entries={entries}
                  activeId={harness}
                  testidPrefix="composer-harness-option"
                  onPick={pickHarness}
                />
              </AnchoredPopover>

              <button
                type="button"
                className="composer-send"
                data-testid="composer-send"
                aria-label="Create agent"
                title="Create agent"
                disabled={submitting || queueing}
                onClick={submit}
              >
                <Icon name="ArrowUp" size={16} />
              </button>
            </div>
          </div>
        </div>
        {/* THE REFUSAL LANDS UNDER THE FIELD (§4.4 step 1, D30): the server's
            own sentence ("acme-app already has an agent called leasing."),
            never the wire shape, and nothing has started. */}
        {submitError && (
          <p
            id="new-agent-error"
            className="modal-error composer-error"
            data-testid="new-agent-error"
            role="alert"
          >
            {submitError}
          </p>
        )}
        <div
          id="composer-attachment-status"
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="composer-attachment-status"
        >
          {attachmentStatus}
        </div>
      </div>

      {templates.length > 0 && (
        <div className="composer-templates">
          <div className="composer-templates-head">
            <span className="composer-templates-title">Start from a template</span>
            <button
              type="button"
              className="composer-templates-all"
              data-testid="composer-browse-templates"
              onClick={onBrowseTemplates}
            >
              Browse all templates <Icon name="ChevronRight" size={13} />
            </button>
          </div>
          <div className="composer-template-grid">
            {templates.map((template, index) => (
              <button
                key={template.id}
                type="button"
                className="composer-template-card"
                data-testid={`composer-template-${template.id}`}
                onClick={() => leaveThen(() => onUseTemplate(template))}
              >
                <span className="composer-template-cardhead">
                  <span className="composer-template-name">{template.name}</span>
                  {index === 0 && (
                    <span className="composer-template-suggested">Suggested</span>
                  )}
                </span>
                <span className="composer-template-desc">{template.description}</span>
                <span className="composer-template-meta">
                  {template.stepCount} {template.stepCount === 1 ? "step" : "steps"} ·{" "}
                  {formatComplexity(template.complexity)}
                  {template.capabilities.length > 0 &&
                    ` · ${template.capabilities.length} ${
                      template.capabilities.length === 1 ? "capability" : "capabilities"
                    }`}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {firstRun && (
        <div className="composer-footer">
          <label className="composer-consent" data-testid="welcome-consent">
            <button
              type="button"
              role="switch"
              aria-checked={telemetryOptIn}
              data-testid="welcome-telemetry-toggle"
              className={"toggle-switch" + (telemetryOptIn ? " is-on" : "")}
              onClick={() => void onToggleTelemetry(!telemetryOptIn)}
            >
              <span className="toggle-knob" />
            </button>
            <span className="composer-consent-copy">
              Help us improve Agent Studio: share your session details with Sapiom. Off by
              default; change it anytime in Settings.
            </span>
          </label>
          <a
            className="composer-docs"
            data-testid="welcome-docs"
            href="https://docs.sapiom.ai/agents/quick-start"
            target="_blank"
            rel="noopener noreferrer"
          >
            Read documentation <Icon name="ArrowUpRight" size={12} />
          </a>
        </div>
      )}
    </div>
  );
}
