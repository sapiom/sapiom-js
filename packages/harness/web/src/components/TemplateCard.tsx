import { useRef, useState } from "react";
import type { JSX } from "react";

import { cadenceLabel } from "../lib/template-facets";
import {
  complexityBasisSummary,
  formatComplexity,
  type GalleryTemplate,
  type StudioTemplate,
} from "../lib/templates";
import { AnchoredPopover } from "./AnchoredPopover";
import { Icon } from "./Icon";
import { Pill } from "./Pill";

/** Tags on the face before the row rolls up into a +N. Three fits the card's
 *  measure on one line at every column count, and cards standing the same
 *  height matters more in a grid than a full tag list one press away. */
const FACE_TAGS = 3;

/**
 * The reference figures, behind an (i).
 *
 * Every field here comes from `TemplateSummary` — what `GET /api/templates`
 * actually returned. That constraint is the point: the numbers a buyer reads off
 * a card have to be the catalog's own. Notably absent, because the DTO has no
 * such fields, are billed-call counts and whether a run stops for an approval;
 * both would have to be guessed here, and a guessed figure on a spec sheet is
 * worse than a missing one.
 *
 * Click, not hover: hover-only detail is unreachable on touch, and the shared
 * popover primitive already handles portalling, collision and dismissal.
 */
function SpecSheet({
  template,
  onPreview,
  onUse,
}: {
  template: GalleryTemplate;
  onPreview: (template: GalleryTemplate) => void;
  onUse: (template: GalleryTemplate) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const facts: Array<{ term: string; value: string; title?: string }> = [
    { term: "Steps", value: String(template.stepCount) },
    {
      term: "Trigger",
      value: template.cadence ? cadenceLabel(template.cadence) : "Not declared",
    },
    {
      term: "Complexity",
      // How involved the template is, which replaced a per-run cost estimate
      // core could only compute for a subset of templates. The basis is the tooltip
      // rather than the value: a band with nothing behind it is an opaque
      // verdict, and saying what produced it is what keeps it honest.
      value: formatComplexity(template.complexity),
      ...(template.complexity
        ? { title: complexityBasisSummary(template.complexity) }
        : { title: "This catalog response carried no complexity band." }),
    },
    {
      term: "Capabilities",
      value:
        template.capabilities.length > 0
          ? String(template.capabilities.length)
          : "None",
    },
  ];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="theme-toggle template-card-info"
        data-testid={`template-card-info-${template.id}`}
        aria-label={`What ${template.name} runs and costs`}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="Info" size={14} />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onDismiss={() => setOpen(false)}
        placement="down-end"
        className="template-facts"
        testid="template-facts"
      >
        <dl className="template-fact-list">
          {facts.map((fact) => (
            <div key={fact.term} className="template-fact">
              <dt>{fact.term}</dt>
              <dd title={fact.title}>{fact.value}</dd>
            </div>
          ))}
        </dl>
        {/* Read the figures, then act on them without going back to the card. */}
        <div className="template-fact-actions">
          <button
            type="button"
            className="btn-line"
            data-testid={`template-facts-preview-${template.id}`}
            onClick={() => {
              setOpen(false);
              onPreview(template);
            }}
          >
            Preview
          </button>
          <button
            type="button"
            className="btn-primary"
            data-testid={`template-facts-use-${template.id}`}
            onClick={() => {
              setOpen(false);
              onUse(template);
            }}
          >
            Use
          </button>
        </div>
      </AnchoredPopover>
    </>
  );
}

/**
 * A template as a card: the two things you choose by (name, description), the
 * tags you might search by, and the figures one press away.
 *
 * The whole face opens the template, and the (i) is a second control inside it.
 * A button may not contain a button, so the face is an `article` with an
 * absolutely-positioned hitbox *under* the content rather than a wrapping
 * element; the content is pointer-transparent except the (i), which sits above
 * the hitbox. That is what allows two targets without nesting one inside the
 * other.
 *
 * `starter` templates take the same card. They carry no `tags`, `cadence` or
 * cost — they are the CLI's bundled scaffolds, not catalog entries — so the tag
 * row and the spec sheet simply do not render for them. Giving them invented
 * values to fill the shape out would put fiction on a spec sheet.
 */
export function TemplateCard({
  template,
  onOpen,
  onUse,
}: {
  template: StudioTemplate;
  onOpen: (template: StudioTemplate) => void;
  onUse: (template: StudioTemplate) => void;
}): JSX.Element {
  const tags =
    template.kind === "gallery" ? template.tags.slice(0, FACE_TAGS) : [];
  const overflow =
    template.kind === "gallery" ? template.tags.length - tags.length : 0;

  return (
    <article
      className="template-card"
      data-testid={`template-card-${template.id}`}
    >
      <button
        type="button"
        className="template-card-hitbox"
        data-testid={`template-card-open-${template.id}`}
        onClick={() => onOpen(template)}
      >
        <span className="visually-hidden">Open {template.name}</span>
      </button>

      <div className="template-card-header">
        <h3 className="template-card-name">{template.name}</h3>
        {template.kind === "gallery" && (
          <SpecSheet template={template} onPreview={onOpen} onUse={onUse} />
        )}
      </div>

      <p className="template-card-desc" data-testid="template-card-desc">
        {template.description}
      </p>

      {template.kind === "starter" ? (
        <div className="template-card-tags">
          {/* The one fact about a starter worth the card's face: its source is
              bundled rather than fetched from the authenticated catalog. */}
          <Pill>bundled</Pill>
        </div>
      ) : (
        tags.length > 0 && (
          <div className="template-card-tags">
            {tags.map((tag) => (
              <Pill key={tag}>{tag}</Pill>
            ))}
            {overflow > 0 && (
              <Pill
                variant="count"
                title={template.tags.slice(FACE_TAGS).join(", ")}
              >
                +{overflow}
              </Pill>
            )}
          </div>
        )
      )}
    </article>
  );
}
