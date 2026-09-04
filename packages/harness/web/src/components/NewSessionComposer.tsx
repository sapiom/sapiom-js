import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import {
  MAX_INLINE_ATTACHMENTS_TOTAL_BYTES,
  type HarnessEntry,
  type HarnessKind,
  type TemplateListResponse,
} from "@shared/types";

import type { FsListResponse } from "../lib/api";
import {
  FALLBACK_HARNESSES,
  harnessLabel,
  isHarnessSelectable,
  orderHarnesses,
} from "../lib/harness-registry";
import { formatComplexity, type GalleryTemplate } from "../lib/templates";
import { loadUiPrefs, saveUiPrefs } from "../lib/ui-prefs";
import { getDesktopBridge } from "../lib/desktop";
import {
  filesToAttachments,
  mergeAttachments,
  type NewSessionAttachment,
} from "../lib/new-session-attachments";
import { AnchoredPopover } from "./AnchoredPopover";
import { StartDialog } from "./StartDialog";
import { HarnessBrandIcon } from "./HarnessBrandIcon";
import { HarnessMenuItems } from "./HarnessMenuItems";
import { Icon } from "./Icon";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/**
 * The composer-first "new session" home. It stands in the centre pane whenever
 * there is no active session (first run, after closing sessions) and when the
 * user asks to start a new one — no terminal, no canvas yet. Describing an
 * outcome and sending starts a session and hands the agent that outcome (the
 * same create+inject path the "start from an idea" door uses); the screen then
 * gives way to the terminal. Templates are the other on-ramp.
 */

/** Quick-start prompts. Net-new — the catalog has no "starter idea" list — so a
 *  small curated set that PREFILLS the box (editable before send), not a
 *  hidden instant-submit. The label is the chip; the prompt is what it types. */
const IDEA_CHIPS: ReadonlyArray<{ label: string; prompt: string }> = [
  {
    label: "sales outreach",
    prompt:
      "Enrich a list of leads, then write a personalized first line for each prospect and draft an outreach email.",
  },
  {
    label: "support triage",
    prompt:
      "Triage incoming support tickets: classify each by urgency and topic, draft a first reply, and flag anything critical.",
  },
  {
    label: "research digest",
    prompt:
      "Search the web for the latest on a topic I give you, then publish a dated digest of what changed.",
  },
  {
    label: "code review",
    prompt:
      "When a pull request opens, review the diff for bugs and style issues and post the findings as a review comment.",
  },
];

/** How many catalog templates the home surfaces before "Browse all templates". */
const HOME_TEMPLATE_COUNT = 3;

function timeGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

function chipSlug(label: string): string {
  return label.replace(/\s+/g, "-");
}

interface NewSessionComposerProps {
  /** Genuine first run (AppState.firstRun): changes the greeting and shows the
   *  one-time telemetry opt-in + docs footer. */
  firstRun: boolean;
  /** Start a session and hand the agent this outcome (empty → default starter).
   *  App derives the folder and runs the scaffold+inject path. */
  onSubmitIdea: (
    idea: string,
    harness: HarnessKind,
    attachments: readonly NewSessionAttachment[],
  ) => Promise<void>;
  /** Surface a file-resolution or submit failure in the app's existing toast. */
  onAttachmentError: (message: string) => void;
  /** Start a session from a catalog template (clone + first run). */
  onUseTemplate: (template: GalleryTemplate, harness: HarnessKind) => void;
  /** Navigate to the full templates catalog. */
  onBrowseTemplates: (harness: HarnessKind) => void;
  /** Adapter registry + template catalog fetches. */
  listHarnesses: () => Promise<HarnessEntry[]>;
  listTemplates: () => Promise<TemplateListResponse>;
  /** First-run telemetry opt-in (SAP-1988): off by default, folded in from the
   *  retired WelcomePanel. */
  telemetryOptIn: boolean;
  onToggleTelemetry: (next: boolean) => Promise<void>;
  /** The leading + opens the add-workspace dialog at its folder door, so
   *  "open an existing folder / connect a workspace" survives the composer. */
  recentDirs: string[];
  projectRoot: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  onConnect: (cwd: string) => Promise<void>;
  onScan: (root: string) => Promise<number>;
  onScaffold: (cwd: string, harness: HarnessKind, idea?: string) => Promise<void>;
  onSaveProjectRoot: (root: string) => Promise<void>;
}

export function NewSessionComposer({
  firstRun,
  onSubmitIdea,
  onAttachmentError,
  onUseTemplate,
  onBrowseTemplates,
  listHarnesses,
  listTemplates,
  telemetryOptIn,
  onToggleTelemetry,
  recentDirs,
  projectRoot,
  listDir,
  onConnect,
  onScan,
  onScaffold,
  onSaveProjectRoot,
}: NewSessionComposerProps): JSX.Element {
  const [idea, setIdea] = useState("");
  const [harness, setHarness] = useState<HarnessKind>(
    () => loadUiPrefs().preferredHarness ?? "claude-code",
  );
  const [entries, setEntries] = useState<HarnessEntry[]>(FALLBACK_HARNESSES);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [templates, setTemplates] = useState<GalleryTemplate[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [attachments, setAttachments] = useState<NewSessionAttachment[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // While the composer is dropping away to make room for the terminal. The
  // action (which starts the session) fires once the exit has played.
  const [leaving, setLeaving] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const harnessTriggerRef = useRef<HTMLButtonElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const attachmentsRef = useRef<NewSessionAttachment[]>([]);
  const submittingRef = useRef(false);
  const queueingRef = useRef(false);
  const queueTailRef = useRef<Promise<void>>(Promise.resolve());
  const pendingQueueCountRef = useRef(0);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  // Registry-driven agent picker, same correction NewSessionModal applies: an
  // uninstalled/external default is never left selected.
  useEffect(() => {
    let cancelled = false;
    listHarnesses()
      .then((registry) => {
        if (cancelled || registry.length === 0) return;
        setEntries(orderHarnesses(registry));
        const selectable = registry.filter(isHarnessSelectable);
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

  // The first few catalog templates for the home's starter row. On failure the
  // row simply doesn't render (the box is still the primary path).
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
    setHarness(kind);
    saveUiPrefs({ preferredHarness: kind === "codex" ? "codex" : "claude-code" });
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
    setLeaving(true);
    const queuedAttachments = attachmentsRef.current;
    window.setTimeout(() => {
      void onSubmitIdea(idea.trim(), harness, queuedAttachments).catch(
        (err: unknown) => {
          submittingRef.current = false;
          setLeaving(false);
          setSubmitting(false);
          textareaRef.current?.focus();
          onAttachmentError(
            (err as Error).message ||
              "Couldn't start a session with those files.",
          );
        },
      );
    }, 170);
  };

  const queueFiles = (files: readonly File[]): void => {
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
      }
    };

    const task = queueTailRef.current.then(processFiles);
    queueTailRef.current = task.catch(() => {});
    void task
      .catch((error: unknown) => {
        onAttachmentError(
          (error as Error).message || "Couldn't attach those files.",
        );
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

  const attachmentCountLabel =
    attachments.length === 0
      ? "No files attached."
      : attachments.length === 1
        ? "1 file attached."
        : `${attachments.length} files attached.`;
  const attachmentStatus = draggingFiles
    ? "Drop files to attach."
    : submitting
      ? `Starting session with ${attachmentCountLabel.toLowerCase()}`
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
        <p className="composer-greeting" data-testid="composer-greeting">
          {timeGreeting(new Date())}{" "}
          {firstRun ? "Let's build your first agent." : "Let's build a new agent."}
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
            (submitting || queueing ? " is-busy" : "")
          }
          data-testid="composer-box"
          role="group"
          aria-label="New session request"
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
            placeholder="Describe the outcome you want"
            aria-label="Describe the outcome you want"
            value={idea}
            rows={2}
            autoFocus
            onChange={(event) => setIdea(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a newline (it's a multi-line outcome).
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {attachments.length > 0 && (
            <ul
              className="composer-files"
              data-testid="composer-files"
              aria-label="Attached files"
            >
              {attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  className="composer-file"
                  {...trackingAttrs({ object: "file" })}
                >
                  <Icon name="Paperclip" size={13} />
                  <span className="composer-file-name" title={attachment.name}>
                    {attachment.name}
                  </span>
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
              ))}
            </ul>
          )}
          <div className="composer-box-actions">
            <button
              ref={addTriggerRef}
              type="button"
              className="composer-attach"
              data-testid="composer-open-folder"
              aria-label="Open a folder or connect a workspace"
              data-tooltip="Open a folder or connect a workspace"
              onClick={() => setAddOpen(true)}
            >
              <Icon name="Plus" size={16} />
            </button>
            <button
              type="button"
              className="composer-attach"
              data-testid="composer-attach-files"
              aria-label="Attach files"
              data-tooltip="Attach files"
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
                aria-label="Start session"
                title="Start session"
                disabled={submitting || queueing}
                onClick={submit}
              >
                <Icon name="ArrowUp" size={16} />
              </button>
            </div>
          </div>
        </div>
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
              onClick={() => onBrowseTemplates(harness)}
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
                onClick={() => leaveThen(() => onUseTemplate(template, harness))}
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
              Help us improve Agent Studio — share your session details with Sapiom. Off by
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

      {addOpen && (
        <StartDialog
          recentDirs={recentDirs}
          projectRoot={projectRoot}
          listDir={listDir}
          onClose={() => setAddOpen(false)}
          onConnect={onConnect}
          onScan={onScan}
          triggerRef={addTriggerRef as RefObject<HTMLElement | null>}
        />
      )}
    </div>
  );
}
