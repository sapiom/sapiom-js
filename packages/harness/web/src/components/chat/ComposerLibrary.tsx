/**
 * Composer library popover — REAL macros (the registry the action bar runs)
 * and REAL skills (the same GET /api/skills the Skills tab reads) offered as
 * insertable prompt templates. Clicking inserts the template into the
 * textarea and hands focus straight back; nothing here submits on its own.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { MacroDef } from "@shared/types";

import type { SkillMeta } from "../../lib/api";
import { AnchoredPopover } from "../AnchoredPopover";
import { Icon } from "../Icon";

/** Same invocation contract as the Skills tab's "Use skill" (SkillsPanel):
 *  package skills are slash-registered, user skills are asked for by name. */
function skillTemplate(skill: SkillMeta): string {
  if (skill.source === "package") return `/${skill.id} `;
  return `Use the "${skill.name}" skill: ${skill.description}`;
}

export interface ComposerLibraryProps {
  macros: MacroDef[];
  listSkills(): Promise<SkillMeta[]>;
  /** Inserts the picked template into the composer and refocuses it. */
  onInsert(text: string): void;
}

export const ComposerLibrary = ({ macros, listSkills, onInsert }: ComposerLibraryProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<SkillMeta[] | null>(null);
  const [skillsError, setSkillsError] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  // Skills load on first open only — the popover is optional chrome and must
  // not fan out a fetch on every keystroke's re-render.
  useEffect(() => {
    if (!open || skills !== null) return;
    let cancelled = false;
    setSkillsError(false);
    listSkills()
      .then((data) => {
        if (!cancelled) setSkills(data);
      })
      .catch(() => {
        if (!cancelled) setSkillsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, skills, listSkills]);

  // Inject-kind macros are the ones that ARE text — open-url and
  // render-canvas actions have no prompt to insert, so they never list here.
  const insertable = macros.filter((macro) => macro.action.kind === "inject");

  const pick = (text: string): void => {
    onInsert(text);
    close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-icon-btn"
        data-testid="composer-library"
        aria-label="Prompt library"
        data-tooltip="Prompt library: insert a macro or skill template"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="BookOpen" size={14} />
      </button>
      {/* Portaled (AnchoredPopover): the composer clips its rounded surface
          with overflow:hidden, so an in-tree panel would crop — this one
          floats above it from document.body, opening upward. */}
      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onDismiss={close}
        placement="up-start"
        className="composer-library"
        role="menu"
        testid="composer-library-menu"
      >
        <>
          {insertable.length > 0 && (
            <>
              <div className="session-dropdown-section">Macros</div>
              {insertable.map((macro) => (
                <button
                  key={macro.id}
                  role="menuitem"
                  className="profile-menu-item"
                  data-testid={`composer-library-macro-${macro.id}`}
                  onClick={() => macro.action.kind === "inject" && pick(macro.action.text)}
                >
                  <Icon name={macro.icon} size={13} />
                  {macro.label}
                </button>
              ))}
            </>
          )}
          <div className="session-dropdown-section">Skills</div>
          {skills === null && !skillsError && <div className="session-dropdown-empty">Loading…</div>}
          {skillsError && <div className="session-dropdown-empty">Skills didn't load. Reopen to retry.</div>}
          {skills !== null && skills.length === 0 && (
            <div className="session-dropdown-empty">No skills yet</div>
          )}
          {skills?.map((skill) => (
            <button
              key={skill.id}
              role="menuitem"
              className="profile-menu-item"
              data-testid={`composer-library-skill-${skill.id}`}
              onClick={() => pick(skillTemplate(skill))}
            >
              <Icon name="Sparkles" size={13} />
              {skill.name}
            </button>
          ))}
        </>
      </AnchoredPopover>
    </>
  );
};
