/**
 * SkillsPanel — read-only skill browser in the right pane alongside the canvas.
 *
 * Skills come from two sources surfaced by GET /api/skills:
 *   - package: shipped with @sapiom/* npm packages
 *   - user: ~/.claude/skills/{id}/SKILL.md
 *
 * Browsing pattern:
 *   - Card list: name + one-line description grouped by source
 *   - Click a card → detail view (rendered markdown body)
 *   - Back button returns to the list
 *
 * Creating skills: place a SKILL.md under ~/.claude/skills/<id>/SKILL.md in
 * your terminal (claude-code or codex) and they appear here automatically.
 * Tell your agent to use a skill when you want it applied — no button needed.
 *
 * Analytics: skill.viewed events are emitted via POST /api/track on card open.
 */
import { useState, useCallback, useEffect, type JSX } from "react";

import type { SkillDetail, SkillMeta } from "../lib/api";
import { ApiError } from "../lib/api";
import { track } from "../lib/track";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

// ---------------------------------------------------------------------------
// Skill detail view
// ---------------------------------------------------------------------------

interface SkillDetailViewProps {
  skill: SkillDetail;
  onBack: () => void;
}

function SkillDetailView({ skill, onBack }: SkillDetailViewProps): JSX.Element {
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
        <p>No skills found yet.</p>
        <p>
          Browse Sapiom's skills and your own here. Create your own under{" "}
          <code>~/.claude/skills/&lt;id&gt;/SKILL.md</code> in the terminal
          (claude-code or codex) and they appear here. Tell your agent to use a
          skill when you want it.
        </p>
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
  /** Fetches the skills list from the API. */
  listSkills: () => Promise<SkillMeta[]>;
  /** Fetches full skill detail (with body). */
  getSkill: (id: string) => Promise<SkillDetail>;
  /**
   * Whether the Skills tab is currently active. The panel is kept alive
   * across tab flips via CSS hide/show, so a mount-only effect would only
   * run on the very first open. Re-fetching when this flips to true ensures
   * a skill created in the terminal while Skills was hidden appears without
   * needing a full page reload.
   */
  isActive: boolean;
}

export function SkillsPanel({ listSkills, getSkill, isActive }: SkillsPanelProps): JSX.Element {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Re-fetch the skill list each time the Skills tab becomes active so newly
  // created skills appear without a page reload. The panel is kept alive via
  // CSS while the Canvas tab is shown, so a mount-only effect is stale after
  // the first open.
  useEffect(() => {
    if (!isActive) return;
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
  }, [isActive, listSkills]);

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

  return (
    <aside className="rail rail-skills" data-testid="skills-panel">
      <div className="rail-header">Skills</div>

      <div className="rail-body">
        {detailLoading ? (
          <div className="skills-loading">Loading…</div>
        ) : selectedSkill ? (
          <SkillDetailView
            skill={selectedSkill}
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
    </aside>
  );
}
