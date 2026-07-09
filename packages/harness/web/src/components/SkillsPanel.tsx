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
 *   - The v0 action is "show accurate per-agent instructions with copy" —
 *     no config file mutation. This is documented in the code as a
 *     deliberate choice: the instructions are human-verified copy-paste
 *     steps, and config-file formats differ per agent version.
 *
 * Analytics seams: marked with ANALYTICS_SEAM comments matching PromptBar's
 * convention. Hook SAP-analytics here once the ui.* layer is landed.
 */
import { useState, useCallback, useEffect, type JSX } from "react";

import type { HarnessSession } from "@shared/types";
import type { SkillDetail, SkillMeta } from "../lib/api";
import { ApiError } from "../lib/api";
import { Icon } from "./Icon";

// ---------------------------------------------------------------------------
// Markdown renderer — safe subset (no dangerouslySetInnerHTML)
// ---------------------------------------------------------------------------

/**
 * Renders a small safe subset of Markdown as React elements:
 *   - ATX headings (# ## ###)
 *   - Fenced code blocks (``` ... ```)
 *   - Blank-line-separated paragraphs
 *   - Unordered lists (- and *)
 *   - Inline backtick code
 *
 * No HTML tags are rendered — input is always treated as plain text tokens,
 * never as markup. Safe to call with untrusted strings.
 */
function renderMarkdown(md: string): JSX.Element {
  const lines = md.split("\n");
  const elements: JSX.Element[] = [];
  let key = 0;
  let i = 0;

  // Inline renderer: bold, code. Text only — no raw HTML.
  function renderInline(text: string): JSX.Element[] {
    const parts: JSX.Element[] = [];
    // `code` spans
    const codeRe = /`([^`]+)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let inlineKey = 0;
    while ((m = codeRe.exec(text)) !== null) {
      if (m.index > last) parts.push(<span key={inlineKey++}>{text.slice(last, m.index)}</span>);
      parts.push(<code key={inlineKey++} className="skill-md-inline-code">{m[1]}</code>);
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(<span key={inlineKey++}>{text.slice(last)}</span>);
    return parts;
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      elements.push(
        <pre key={key++} className="skill-md-pre">
          <code className={lang ? `language-${lang}` : undefined}>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // ATX headings
    const hMatch = /^(#{1,3})\s+(.*)/.exec(line);
    if (hMatch) {
      const level = hMatch[1].length as 1 | 2 | 3;
      const Tag = (`h${level}`) as "h1" | "h2" | "h3";
      elements.push(<Tag key={key++} className={`skill-md-h${level}`}>{hMatch[2]}</Tag>);
      i++;
      continue;
    }

    // Unordered list: collect consecutive "- " or "* " lines
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s/, ""));
        i++;
      }
      elements.push(
        <ul key={key++} className="skill-md-ul">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Task-list items (- [ ] or - [x])
    if (/^- \[[ x]\]/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^- \[[ x]\]/.test(lines[i])) {
        items.push(lines[i].replace(/^- \[[ x]\]\s?/, ""));
        i++;
      }
      elements.push(
        <ul key={key++} className="skill-md-ul skill-md-checklist">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Blank line → separator (skip)
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: collect non-blank, non-heading, non-list lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^[#`\-*]/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      elements.push(
        <p key={key++} className="skill-md-p">
          {renderInline(paraLines.join(" "))}
        </p>,
      );
    } else {
      // Catch-all: render as paragraph to avoid infinite loop
      elements.push(<p key={key++} className="skill-md-p">{renderInline(line)}</p>);
      i++;
    }
  }

  return <div className="skill-md">{elements}</div>;
}

// ---------------------------------------------------------------------------
// Install-MCP modal
// ---------------------------------------------------------------------------

interface InstallMcpModalProps {
  activeHarness: string | null;
  onClose: () => void;
}

// Static per-harness install instructions (sourced from the adapter registry's
// installMcpPrompt() texts — kept here as constants so the SPA doesn't need
// a separate API call; the registry text is the canonical source).
const HARNESS_INSTALL_PROMPTS: Record<string, { label: string; text: string }> = {
  "claude-code": {
    label: "Claude Code",
    text: [
      "Set up the Sapiom MCP server for Claude Code.",
      "",
      "1. Register it under the server name `sapiom-dev`:",
      "",
      "   claude mcp add sapiom-dev -- npx -y @sapiom/mcp",
      "",
      "   The `@sapiom/mcp` npm package ships the `sapiom-mcp` binary, a local",
      "   MCP server that speaks stdio — no global install or daemon needed.",
      "2. Verify the registration: `claude mcp list` should show `sapiom-dev`.",
      "3. Restart Claude Code (or start a new session) so the server is loaded.",
      "4. Networked Sapiom tools need an API key: run the `sapiom_authenticate`",
      "   tool once and complete the browser login it opens.",
    ].join("\n"),
  },
  "codex": {
    label: "Codex",
    text: [
      "Set up the Sapiom MCP server for OpenAI Codex CLI.",
      "",
      "1. Add the server to your Codex config file (~/.codex/config.yaml):",
      "",
      "   mcpServers:",
      "     sapiom-dev:",
      "       command: npx",
      "       args: [\"-y\", \"@sapiom/mcp\"]",
      "",
      "2. Restart Codex so the server is loaded.",
      "3. Networked Sapiom tools need an API key: run the `sapiom_authenticate`",
      "   tool once and complete the browser login it opens.",
    ].join("\n"),
  },
};

const HARNESS_ORDER = ["claude-code", "codex"];

function InstallMcpModal({ activeHarness, onClose }: InstallMcpModalProps): JSX.Element {
  const [selectedHarness, setSelectedHarness] = useState<string>(
    activeHarness ?? "claude-code",
  );
  const [copied, setCopied] = useState(false);

  const entry = HARNESS_INSTALL_PROMPTS[selectedHarness];

  const handleCopy = useCallback(async () => {
    if (!entry) return;
    try {
      await navigator.clipboard.writeText(entry.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — silently ignore.
    }
    // ANALYTICS_SEAM: emit mcp.install event here (SAP-analytics).
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
        {!activeHarness && (
          <div className="install-mcp-picker">
            {HARNESS_ORDER.filter((h) => HARNESS_INSTALL_PROMPTS[h]).map((h) => (
              <button
                key={h}
                className={"install-mcp-tab" + (selectedHarness === h ? " is-selected" : "")}
                onClick={() => setSelectedHarness(h)}
              >
                {HARNESS_INSTALL_PROMPTS[h].label}
              </button>
            ))}
          </div>
        )}

        {entry && (
          <pre className="install-mcp-instructions" data-testid="install-mcp-instructions">
            {entry.text}
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
    // ANALYTICS_SEAM: emit skill.used event here (SAP-analytics).
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
        {renderMarkdown(skill.body)}
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
}

export function SkillsPanel({ session, onInjectInput, listSkills, getSkill }: SkillsPanelProps): JSX.Element {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [installMcpOpen, setInstallMcpOpen] = useState(false);

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

  const handleSelectSkill = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      // ANALYTICS_SEAM: emit skill.viewed event here (SAP-analytics).
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
          onClose={() => setInstallMcpOpen(false)}
        />
      )}
    </aside>
  );
}
