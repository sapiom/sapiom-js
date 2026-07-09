/**
 * SkillsPanel — Skills tab in the right pane alongside the canvas.
 *
 * Skills come from two sources surfaced by GET /api/skills:
 *   - package: shipped with @sapiom/* npm packages
 *   - user: ~/.claude/skills/{id}/SKILL.md
 *
 * NON-TECHNICAL browsing pattern:
 *   - Card list: name + one-line description
 *   - Click a card → detail view (rendered markdown body)
 *   - "Use" button → injects an invocation prompt into the active session
 *     via POST /api/sessions/:id/input (same path as the prompt bar).
 *     Disabled with reason when no ready session (mirrors PromptBar's
 *     readiness logic).
 *
 * Install-MCP action:
 *   - Footer button that opens a modal with per-agent instructions from
 *     the adapter registry's installMcpPrompt() text.
 *   - When an active session exists its harness kind determines which
 *     adapter's text to show; otherwise we show a picker of all adapters.
 *   - The action is "show accurate per-agent instructions with copy" —
 *     no config file mutation. This is a deliberate choice: the instructions
 *     are human-verified copy-paste steps, and config-file formats differ
 *     per agent version.
 *
 * Analytics: skill.viewed, skill.used, and mcp.install events are emitted
 * via POST /api/track on the relevant user actions.
 */
import { useState, useCallback, useEffect, type JSX } from "react";

import type { HarnessSession } from "@shared/types";
import type { HarnessEntry, SkillDetail, SkillMeta } from "../lib/api";
import { ApiError } from "../lib/api";
import { track } from "../lib/track";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

// ---------------------------------------------------------------------------
// Install-MCP modal
// ---------------------------------------------------------------------------

interface InstallMcpModalProps {
  activeHarness: string | null;
  /** Harness adapter list — fetched from GET /api/harnesses at open time. */
  harnesses: HarnessEntry[];
  onClose: () => void;
}

function InstallMcpModal({ activeHarness, harnesses, onClose }: InstallMcpModalProps): JSX.Element {
  // Embedded adapters only — external harnesses (conductor) have no MCP concept.
  const embeddedHarnesses = harnesses.filter((h) => h.mode === "embedded");
  const defaultId = activeHarness ?? embeddedHarnesses[0]?.id ?? "";
  const [selectedId, setSelectedId] = useState<string>(defaultId);
  const [copied, setCopied] = useState(false);

  const entry = embeddedHarnesses.find((h) => h.id === selectedId);

  const handleCopy = useCallback(async () => {
    if (!entry) return;
    try {
      await navigator.clipboard.writeText(entry.installMcpPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — silently ignore.
    }
    track("mcp.install", { harness: entry.id });
  }, [entry]);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Install Sapiom MCP"
    >
      <div className="modal install-mcp-modal">
        <div className="modal-header install-mcp-header">
          <span className="modal-title">Install Sapiom MCP</span>
          <button className="btn-ghost install-mcp-close" onClick={onClose} aria-label="Close">
            <Icon name="X" size={14} />
          </button>
        </div>

        <p className="install-mcp-intro">
          Install the Sapiom MCP server into your agent's own config so it's
          available outside harness sessions.
        </p>

        {/* Harness picker — only shown when no session determines the kind. */}
        {!activeHarness && embeddedHarnesses.length > 1 && (
          <div className="install-mcp-picker">
            {embeddedHarnesses.map((h) => (
              <button
                key={h.id}
                className={"install-mcp-tab" + (selectedId === h.id ? " is-selected" : "")}
                onClick={() => setSelectedId(h.id)}
              >
                {h.label}
              </button>
            ))}
          </div>
        )}

        {entry && (
          <pre className="install-mcp-instructions" data-testid="install-mcp-instructions">
            {entry.installMcpPrompt}
          </pre>
        )}

        <div className="modal-actions">
          <button
            className="btn-primary install-mcp-copy"
            onClick={() => void handleCopy()}
            data-testid="install-mcp-copy"
          >
            {copied ? "Copied!" : "Copy instructions"}
          </button>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skill detail view
// ---------------------------------------------------------------------------

interface SkillDetailViewProps {
  skill: SkillDetail;
  session: HarnessSession | null;
  onUse: (text: string) => void;
  onBack: () => void;
}

/** Derive the readiness reason from a session — same logic as PromptBar. */
function sessionReadyReason(session: HarnessSession | null): string | null {
  if (!session) return "No active session — start one to use skills.";
  if (session.status === "exited") return "Session ended — resume it to use skills.";
  if (session.status === "starting" || !session.ready) return "Session is starting…";
  return null;
}

function SkillDetailView({ skill, session, onUse, onBack }: SkillDetailViewProps): JSX.Element {
  const notReadyReason = sessionReadyReason(session);

  const handleUse = useCallback(() => {
    const prompt = `Use the "${skill.name}" skill: ${skill.description}`;
    onUse(prompt);
    track("skill.used", { skillId: skill.id });
  }, [skill, onUse]);

  return (
    <div className="skill-detail" data-testid="skill-detail">
      <div className="skill-detail-header">
        <button className="skill-back btn-ghost" onClick={onBack} data-testid="skill-back" aria-label="Back to skills list">
          <Icon name="ArrowLeft" size={13} />
        </button>
        <span className="skill-detail-name">{skill.name}</span>
        <span className={"skill-source-badge skill-source-" + skill.source}>
          {skill.source === "user" ? "user" : "pkg"}
        </span>
      </div>

      <div className="skill-detail-body">
        <Markdown text={skill.body} />
      </div>

      <div className="skill-detail-footer">
        <button
          className="btn-primary skill-use-btn"
          disabled={Boolean(notReadyReason)}
          title={notReadyReason ?? undefined}
          onClick={handleUse}
          data-testid="skill-use-btn"
        >
          Use skill
        </button>
        {notReadyReason && (
          <span className="skill-use-reason">{notReadyReason}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills list
// ---------------------------------------------------------------------------

interface SkillsListProps {
  skills: SkillMeta[];
  loading: boolean;
  error: string | null;
  onSelectSkill: (id: string) => void;
}

function SkillsList({ skills, loading, error, onSelectSkill }: SkillsListProps): JSX.Element {
  if (loading) {
    return <div className="skills-loading">Loading skills…</div>;
  }
  if (error) {
    return <div className="skills-error">{error}</div>;
  }
  if (skills.length === 0) {
    return (
      <div className="skills-empty">
        No skills found. Add skills to <code>~/.claude/skills/</code>.
      </div>
    );
  }

  // Group by source: user skills first, then package skills.
  const userSkills = skills.filter((s) => s.source === "user");
  const pkgSkills = skills.filter((s) => s.source === "package");

  const renderGroup = (group: SkillMeta[], label: string): JSX.Element | null => {
    if (group.length === 0) return null;
    return (
      <div key={label} className="skills-group">
        <div className="skills-group-header">{label}</div>
        {group.map((skill) => (
          <button
            key={skill.id}
            className="skill-card"
            data-testid={`skill-card-${skill.id}`}
            onClick={() => onSelectSkill(skill.id)}
          >
            <span className="skill-card-name">{skill.name}</span>
            <span className="skill-card-desc">{skill.description}</span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="skills-list" data-testid="skills-list">
      {renderGroup(userSkills, "Your skills")}
      {renderGroup(pkgSkills, "Sapiom")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SkillsPanel root
// ---------------------------------------------------------------------------

export interface SkillsPanelProps {
  /** The active session — drives the "Use" button readiness and Install-MCP labeling. */
  session: HarnessSession | null;
  /** Called to inject text into the active session's pty (same as PromptBar). */
  onInjectInput: (sessionId: string, text: string) => Promise<void>;
  /** Fetches the skills list from the API. */
  listSkills: () => Promise<SkillMeta[]>;
  /** Fetches full skill detail (with body). */
  getSkill: (id: string) => Promise<SkillDetail>;
  /** Fetches harness adapter list (includes installMcpPrompt for the modal). */
  listHarnesses: () => Promise<HarnessEntry[]>;
}

export function SkillsPanel({ session, onInjectInput, listSkills, getSkill, listHarnesses }: SkillsPanelProps): JSX.Element {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [installMcpOpen, setInstallMcpOpen] = useState(false);
  const [harnesses, setHarnesses] = useState<HarnessEntry[]>([]);

  // Load skill list on mount.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listSkills()
      .then((data) => {
        if (!cancelled) setSkills(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listSkills]);

  // Load harness adapter list for the Install-MCP modal (fetched once per
  // mount — the list is stable across the session's lifetime).
  useEffect(() => {
    let cancelled = false;
    listHarnesses()
      .then((data) => {
        if (!cancelled) setHarnesses(data);
      })
      .catch(() => {
        // Non-critical — the modal degrades gracefully with an empty list.
      });
    return () => {
      cancelled = true;
    };
  }, [listHarnesses]);

  const handleSelectSkill = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      track("skill.viewed", { skillId: id });
      try {
        const detail = await getSkill(id);
        setSelectedSkill(detail);
      } catch (err) {
        const msg = err instanceof ApiError ? (err.reason ?? err.message) : (err as Error).message;
        setError(msg);
      } finally {
        setDetailLoading(false);
      }
    },
    [getSkill],
  );

  const handleUse = useCallback(
    async (text: string) => {
      if (!session) return;
      try {
        await onInjectInput(session.id, text);
      } catch {
        // Errors surface in the prompt bar's own reactive state; swallow here.
      }
    },
    [session, onInjectInput],
  );

  return (
    <aside className="rail rail-skills" data-testid="skills-panel">
      <div className="rail-header">Skills</div>

      <div className="rail-body">
        {detailLoading ? (
          <div className="skills-loading">Loading…</div>
        ) : selectedSkill ? (
          <SkillDetailView
            skill={selectedSkill}
            session={session}
            onUse={(text) => void handleUse(text)}
            onBack={() => setSelectedSkill(null)}
          />
        ) : (
          <SkillsList
            skills={skills}
            loading={loading}
            error={error}
            onSelectSkill={(id) => void handleSelectSkill(id)}
          />
        )}
      </div>

      <div className="skills-footer">
        <button
          className="install-mcp-trigger btn-ghost"
          data-testid="install-mcp-trigger"
          onClick={() => setInstallMcpOpen(true)}
        >
          <Icon name="Plug" size={13} />
          Install Sapiom MCP
        </button>
      </div>

      {installMcpOpen && (
        <InstallMcpModal
          activeHarness={session?.harness ?? null}
          harnesses={harnesses}
          onClose={() => setInstallMcpOpen(false)}
        />
      )}
    </aside>
  );
}
