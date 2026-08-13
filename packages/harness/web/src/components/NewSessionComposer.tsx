import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import type { HarnessEntry, HarnessKind, TemplateListResponse } from "@shared/types";

import type { FsListResponse } from "../lib/api";
import {
  FALLBACK_HARNESSES,
  harnessLabel,
  isHarnessSelectable,
  orderHarnesses,
} from "../lib/harness-registry";
import { formatComplexity, type GalleryTemplate } from "../lib/templates";
import { loadUiPrefs, saveUiPrefs } from "../lib/ui-prefs";
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
  onSubmitIdea: (idea: string, harness: HarnessKind) => void;
  /** Start a session from a catalog template (clone + first run). */
  onUseTemplate: (template: GalleryTemplate) => void;
  /** Navigate to the full templates catalog. */
  onBrowseTemplates: () => void;
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
  // While the composer is dropping away to make room for the terminal. The
  // action (which starts the session) fires once the exit has played.
  const [leaving, setLeaving] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const harnessTriggerRef = useRef<HTMLButtonElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
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
  const submit = (): void => leaveThen(() => onSubmitIdea(idea.trim(), harness));

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

        <div className="composer-box">
          <textarea
            ref={textareaRef}
            className="composer-input"
            data-testid="composer-input"
            placeholder="Describe the outcome you want"
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
                onClick={submit}
              >
                <Icon name="ArrowUp" size={16} />
              </button>
            </div>
          </div>
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
