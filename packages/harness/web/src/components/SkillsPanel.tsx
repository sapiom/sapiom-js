/**
 * SkillsPanel — skill browser in the right pane alongside the canvas.
 *
 * Skills come from two sources surfaced by GET /api/skills:
 *   - package: shipped with @sapiom/* npm packages (slash-registered in sessions)
 *   - user: ~/.claude/skills/{id}/SKILL.md
 *
 * Browsing pattern:
 *   - Card list: name + one-line description grouped by source
 *   - Click a card → detail view (rendered markdown body)
 *   - Back button returns to the list
 *   - "Use skill" button in the detail view populates the terminal's input
 *     line WITHOUT submitting (submit:false), so the user can review and
 *     edit before pressing Enter.
 *
 * Use-skill text depends on the skill's source:
 *   - package skill → "/<id> " (trailing space for args; slash-registered by
 *     the session's --plugin-dir injection)
 *   - user skill → natural-language invocation "Use the \"<name>\" skill: <desc>"
 *
 * Requires an active, ready session: the button is disabled with a short
 * reason when there is no ready session.
 *
 * Creating skills: place a SKILL.md under ~/.claude/skills/<id>/SKILL.md in
 * your terminal (claude-code or codex) and they appear here automatically.
 *
 * Analytics: skill.viewed + skill.used events are emitted via POST /api/track.
 */
import { useState, useCallback, useEffect, type JSX } from "react";

import type { HarnessSession } from "@shared/types";
import type { SkillDetail, SkillMeta } from "../lib/api";
import { ApiError } from "../lib/api";
import { track } from "../lib/track";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

// ---------------------------------------------------------------------------
// Skill detail view
// ---------------------------------------------------------------------------

/**
 * Returns the text to inject into the terminal when "Use skill" is clicked.
 *   - package skill: "/<id> " — the slash command with a trailing space for args
 *   - user skill: natural-language invocation (user skills aren't slash-registered)
 */
function skillInjectText(skill: SkillDetail): string {
  if (skill.source === "package") {
    return `/${skill.id} `;
  }
  return `Use the "${skill.name}" skill: ${skill.description}`;
}

/** The detail header already shows the skill's name — a body that leads
 *  with the same `# Name` heading would render the title twice, 40px apart
 * . Only an exact duplicate is dropped; any other heading stays. */
function stripDuplicateTitle(body: string, name: string): string {
  const match = body.match(/^\s*#\s+(.+?)\s*\n/);
  if (match && match[1].trim().toLowerCase() === name.trim().toLowerCase()) {
    return body.slice(match[0].length).replace(/^\n+/, "");
  }
  return body;
}

interface SkillDetailViewProps {
  skill: SkillDetail;
  onBack: () => void;
  /** The active session, if any — needed to gate and fire "Use skill". */
  activeSession: HarnessSession | null;
  /** Populates the terminal's input line without submitting. */
  onUseSkill: (text: string) => void;
}

/**
 * Shared gate for anything that injects text into the terminal (Use skill,
 * Create skill): needs a live, ready session to have somewhere to land.
 */
function sessionGate(activeSession: HarnessSession | null): string | null {
  return !activeSession
    ? "No active session"
    : activeSession.status === "exited"
      ? "Session has exited"
      : !activeSession.ready
        ? "Session is starting"
        : null;
}

function SkillDetailView({ skill, onBack, activeSession, onUseSkill }: SkillDetailViewProps): JSX.Element {
  const disabledReason = sessionGate(activeSession);
  const isReady = disabledReason === null;

  const handleUseSkill = (): void => {
    if (!isReady) return;
    track("skill.used", { skillId: skill.id, source: skill.source });
    onUseSkill(skillInjectText(skill));
  };

  return (
    <div className="skill-detail" data-testid="skill-detail">
      <div className="skill-detail-header">
        <button
          className="skill-back"
          onClick={onBack}
          data-testid="skill-back"
          aria-label="Back to skills list"
          data-tooltip="Back to skills list"
        >
          <Icon name="ArrowLeft" size={13} />
        </button>
        <span className="skill-detail-title">
          <span className="skill-detail-name">{skill.name}</span>
          {skill.source === "user" && (
            <span className="status-tag skill-source-badge" title="A skill you added, under ~/.claude/skills">
              user
            </span>
          )}
        </span>
        <button
          className="skill-use-btn btn-primary"
          data-testid="skill-use-btn"
          disabled={!isReady}
          title={disabledReason ?? "Populate the terminal with this skill"}
          onClick={handleUseSkill}
          aria-label={disabledReason ? `Use skill: ${disabledReason}` : "Use skill"}
        >
          Use skill
        </button>
      </div>

      {disabledReason && (
        <div className="skill-detail-reason">
          <span data-testid="skill-use-disabled-reason">{disabledReason}</span>
        </div>
      )}

      <div className="skill-detail-body">
        <Markdown text={stripDuplicateTitle(skill.body, skill.name)} />
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
  /** True while a filter query is narrowing the list — changes the empty copy. */
  filterActive: boolean;
  onSelectSkill: (id: string) => void;
}

function SkillsList({ skills, loading, error, filterActive, onSelectSkill }: SkillsListProps): JSX.Element {
  if (loading) {
    return <div className="skills-loading">Loading skills…</div>;
  }
  if (error) {
    return (
      <div className="skills-error" data-testid="skills-error" role="alert">
        {error}
      </div>
    );
  }
  if (skills.length === 0 && filterActive) {
    return (
      <EmptyState
        className="skills-empty"
        title="No skills match that filter"
        body="Clear the filter to see every skill again."
      />
    );
  }
  if (skills.length === 0) {
    return (
      <EmptyState
        className="skills-empty"
        icon="BookOpen"
        title="No skills found yet"
        body={
          <>
            Browse Sapiom's skills and your own here. Create your own under{" "}
            <code>~/.claude/skills/&lt;id&gt;/SKILL.md</code> in the terminal (claude-code or
            codex) and they appear here. Tell your agent to use a skill when you want it.
          </>
        }
      />
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
            <span className="skill-card-copy">
              <span className="skill-card-name">{skill.name}</span>
              <span className="skill-card-desc">{skill.description}</span>
            </span>
            {/* Navigation row, not an accordion: the right-pointing chevron
                says "opens the detail view" (caret contract). */}
            <span className="skill-card-caret" aria-hidden="true">
              <Icon name="ChevronRight" size={13} />
            </span>
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
  /** The currently active session — used to gate the "Use skill" button. */
  activeSession: HarnessSession | null;
  /**
   * Populates the terminal's input line with `text` WITHOUT submitting.
   * Called when the user clicks "Use skill" in the detail view.
   */
  onUseSkill: (sessionId: string, text: string) => void;
}

export function SkillsPanel({ listSkills, getSkill, isActive, activeSession, onUseSkill }: SkillsPanelProps): JSX.Element {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Which skill the failed detail fetch was for — the error state's Retry
  // re-runs the same fetch instead of dead-ending.
  const [detailErrorId, setDetailErrorId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

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
      setDetailError(null);
      setDetailErrorId(null);
      track("skill.viewed", { skillId: id });
      try {
        const detail = await getSkill(id);
        setSelectedSkill(detail);
      } catch (err) {
        // Scoped to the detail view (with its own back affordance) so a failed
        // open never wipes the still-valid list behind it.
        const msg = err instanceof ApiError ? (err.reason ?? err.message) : (err as Error).message;
        setDetailError(msg);
        setDetailErrorId(id);
      } finally {
        setDetailLoading(false);
      }
    },
    [getSkill],
  );

  // The list view leads with a full-width filter field — same anatomy and
  // tokens as the main nav's jump field — instead of a label-only header row.
  const showFilter = !detailLoading && !detailError && !selectedSkill;
  const query = filter.trim().toLowerCase();
  const visibleSkills = query
    ? skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(query))
    : skills;

  const createDisabledReason = sessionGate(activeSession);
  // No dedicated analytics event exists for this in the server's UiEventName
  // contract (see harness-types.ts) — not invented here; this is a plain
  // terminal-injection convenience, same mechanism as "Use skill".
  const handleCreateSkill = (): void => {
    if (createDisabledReason || !activeSession) return;
    onUseSkill(activeSession.id, "Create a new Sapiom skill: ");
  };

  return (
    <aside className="rail rail-skills" data-testid="skills-panel">
      {showFilter && (
        <div className="rail-search">
          <label className="palette-trigger skills-filter-field">
            <Icon name="Search" size={13} />
            <input
              data-testid="skills-filter"
              placeholder="Filter skills…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter skills"
            />
          </label>
          <button
            className="skill-back skills-create-btn"
            data-testid="skills-create"
            disabled={Boolean(createDisabledReason)}
            title={
              createDisabledReason
                ? `Create skill: ${createDisabledReason}`
                : "Create skill: asks the agent to scaffold a new SKILL.md"
            }
            aria-label={createDisabledReason ? `Create skill: ${createDisabledReason}` : "Create skill"}
            onClick={handleCreateSkill}
          >
            <Icon name="Plus" size={14} />
          </button>
        </div>
      )}

      <div className="rail-body">
        {detailLoading ? (
          <div className="skills-loading">Loading…</div>
        ) : detailError ? (
          /* Same anatomy as the canvas error card: icon, ONE message
             (no duplicated headline), and a Retry that refires the fetch. */
          <div className="skill-detail" data-testid="skill-detail-error">
            <div className="skill-detail-header">
              <button
                className="skill-back btn-ghost"
                onClick={() => {
                  setDetailError(null);
                  setDetailErrorId(null);
                }}
                data-testid="skill-detail-error-back"
                aria-label="Back to skills list"
                data-tooltip="Back to skills list"
              >
                <Icon name="ArrowLeft" size={13} />
              </button>
            </div>
            <div className="skill-detail-error-state" role="alert">
              <span className="canvas-error-icon" aria-hidden="true">
                <Icon name="TriangleAlert" size={20} />
              </span>
              <p className="skill-detail-error-msg">{detailError}</p>
              {detailErrorId && (
                <button
                  className="btn-primary"
                  data-testid="skill-detail-retry"
                  onClick={() => void handleSelectSkill(detailErrorId)}
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        ) : selectedSkill ? (
          <SkillDetailView
            skill={selectedSkill}
            onBack={() => setSelectedSkill(null)}
            activeSession={activeSession}
            onUseSkill={(text) => {
              if (activeSession) onUseSkill(activeSession.id, text);
            }}
          />
        ) : (
          <SkillsList
            skills={visibleSkills}
            loading={loading}
            error={error}
            filterActive={Boolean(query)}
            onSelectSkill={(id) => void handleSelectSkill(id)}
          />
        )}
      </div>
    </aside>
  );
}
