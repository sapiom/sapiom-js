import { useEffect, useState } from "react";
import type { JSX } from "react";

import type { TemplateDetailView } from "@shared/types";

import { formatEstCost, templateGraph, type StudioTemplate } from "../lib/templates";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

/**
 * The template's step structure, previewed with the canvas projections'
 * vocabulary (templateGraph → kind dots, elbow transition rows) before anything
 * is cloned. Pure projection of what core served: the same nodes and edges the
 * canvas renders (deterministically) once the clone lands.
 */
function TemplateGraphPreview({ detail }: { detail: TemplateDetailView }): JSX.Element {
  const graph = templateGraph(detail);
  return (
    <div className="template-graph" data-testid="template-graph">
      {graph.nodes.map((node) => {
        const outgoing = graph.edges.filter((e) => e.from === node.id);
        return (
          <div key={node.id} className="template-graph-item" data-testid={`template-graph-node-${node.id}`}>
            <div className="template-graph-node">
              <span className={"canvas-step-dot dot--" + node.kind} aria-hidden="true" />
              <span className="template-graph-name">{node.label}</span>
              {node.kind === "terminal-success" && <span className="template-step-exit">exit</span>}
              {node.capabilities.map((capability) => (
                <code key={capability} className="template-cap">
                  {capability}
                </code>
              ))}
            </div>
            {outgoing.map((edge) => (
              <div key={`${edge.from}->${edge.to}`} className="canvas-step-transition template-graph-edge">
                <Icon name="CornerDownRight" size={12} />
                <span className="canvas-step-transition-target">{edge.to}</span>
                {edge.label && <span className="canvas-step-transition-label">{edge.label}</span>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Pretty-printed example payload — the manifest's own JSON, verbatim. */
function ExampleBlock({
  example,
  index,
}: {
  example: TemplateDetailView["examples"][number];
  index: number;
}): JSX.Element {
  return (
    <details className="template-example">
      <summary className="template-example-summary">{example.title ?? `Example ${index + 1}`}</summary>
      <div className="template-example-body">
        <span className="template-example-label">Input</span>
        <pre className="template-example-json">{JSON.stringify(example.input, null, 2)}</pre>
        {/* A manifest may declare an input without an output; don't render an
            empty "Output" block claiming the run produces null. */}
        {example.output !== null && (
          <>
            <span className="template-example-label">Output</span>
            <pre className="template-example-json">{JSON.stringify(example.output, null, 2)}</pre>
          </>
        )}
      </div>
    </details>
  );
}

/**
 * A catalog template's detail, from `GET /api/templates/:id`. Every section is
 * conditional on the manifest actually carrying that field: templates in the
 * registry declare these optionally, so an absent `notes`/`useCases`/`examples`
 * must render as nothing rather than an empty heading.
 */
function GalleryDetail({ detail }: { detail: TemplateDetailView }): JSX.Element {
  return (
    <>
      {detail.whatItDoes && <p className="template-lead">{detail.whatItDoes}</p>}

      {detail.steps.length > 0 && (
        <section className="template-section">
          <h4 className="template-section-title">Steps</h4>
          {/* Structure first (the canvas vocabulary), then the ordered list with
              each step's description. Same manifest, two readings. */}
          <TemplateGraphPreview detail={detail} />
          <ol className="template-steps">
            {detail.steps.map((step, index) => (
              <li key={step.name} className="template-step">
                <span className="template-step-index" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="template-step-copy">
                  <span className="template-step-name">
                    {step.name}
                    {step.terminal && <span className="template-step-exit">exit</span>}
                  </span>
                  {step.description && <span className="template-step-desc">{step.description}</span>}
                </span>
                {step.capabilities.map((capability) => (
                  <code key={capability} className="template-cap">
                    {capability}
                  </code>
                ))}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="template-section">
        <h4 className="template-section-title">Capabilities and cost</h4>
        {detail.capabilities.length > 0 ? (
          <>
            <div className="template-caps">
              {detail.capabilities.map((capability) => (
                <code key={capability} className="template-cap">
                  {capability}
                </code>
              ))}
            </div>
            <p className="template-note" data-testid="template-cost-note">
              {detail.estCostPerRunUsd === null ? (
                <>
                  Metered capabilities set the per-run price. Sapiom has no per-call price for these,
                  so no estimate is shown. Local test runs stub every capability and are free.
                </>
              ) : (
                <>
                  Estimated <strong>{formatEstCost(detail.estCostPerRunUsd)}</strong> per run, from these
                  capabilities at current prices. Local test runs stub every capability and are free.
                </>
              )}
            </p>
          </>
        ) : (
          <p className="template-note" data-testid="template-cost-note">
            No metered capabilities, so runs record no capability cost.
          </p>
        )}
      </section>

      {detail.requiredSecrets.length > 0 && (
        <section className="template-section">
          <h4 className="template-section-title">Credentials you supply</h4>
          <ul className="template-usecases">
            {detail.requiredSecrets.map((secret) => (
              <li key={secret.key}>
                <code className="template-cap">{secret.key}</code> {secret.label}
                {secret.description && <> — {secret.description}</>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.useCases.length > 0 && (
        <section className="template-section">
          <h4 className="template-section-title">Use cases</h4>
          <ul className="template-usecases">
            {detail.useCases.map((useCase) => (
              <li key={useCase}>{useCase}</li>
            ))}
          </ul>
        </section>
      )}

      {detail.examples.length > 0 && (
        <section className="template-section">
          <h4 className="template-section-title">Examples</h4>
          {detail.examples.map((example, index) => (
            <ExampleBlock key={example.title ?? index} example={example} index={index} />
          ))}
        </section>
      )}

      {detail.notes && (
        <section className="template-section">
          <h4 className="template-section-title">Notes</h4>
          <div className="template-notes">
            <Markdown text={detail.notes} />
          </div>
        </section>
      )}
    </>
  );
}

/**
 * The preview pane of the templates dialog: real manifest fields only. A catalog
 * template's detail is fetched on selection (`GET /api/templates/:id`); a bundled
 * starter renders the one honest sentence the scaffold tool ships about it —
 * starters have no manifest, so nothing more is claimed.
 */
export function TemplateDetail({
  template,
  getTemplate,
}: {
  template: StudioTemplate;
  getTemplate: (id: string) => Promise<TemplateDetailView>;
}): JSX.Element {
  const [detail, setDetail] = useState<TemplateDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (template.kind !== "gallery") {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    // Clear first so switching templates never shows the previous one's manifest
    // under the new one's name.
    setDetail(null);
    setError(null);
    getTemplate(template.id)
      .then((loaded) => {
        if (!cancelled) setDetail(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [template.kind, template.id, getTemplate]);

  return (
    <div className="template-detail" data-testid="template-detail">
      <div className="template-detail-head">
        <h3 className="template-detail-name">{template.name}</h3>
        <div className="template-tags">
          {(template.kind === "gallery" ? template.tags : ["bundled"]).map((tag) => (
            <span key={tag} className="template-tag">
              {tag}
            </span>
          ))}
        </div>
      </div>
      {template.kind === "gallery" ? (
        <>
          {detail?.author && (
            <span className="template-byline">
              By{" "}
              {detail.author.url ? (
                <a href={detail.author.url} target="_blank" rel="noopener noreferrer">
                  {detail.author.name}
                </a>
              ) : (
                detail.author.name
              )}
            </span>
          )}
          {/* The summary's description always renders, so the pane is never bare
              while the manifest loads. */}
          {!detail && !error && <p className="template-lead">{template.description}</p>}
          {error && (
            <p className="template-note" data-testid="template-detail-error">
              Could not load this template’s details: {error}
            </p>
          )}
          {detail && <GalleryDetail detail={detail} />}
        </>
      ) : (
        <>
          <p className="template-lead">{template.description}</p>
          <p className="template-note">
            Scaffolds an npm-install-ready TypeScript project with a starter agent in index.ts.
          </p>
        </>
      )}
      {/* What "Use template" really does — the two paths differ, say so. */}
      <p className="template-handoff" data-testid="template-handoff">
        {template.kind === "gallery"
          ? "Using it forks the template into a repo you own, then clones it here. Needs a signed-in Sapiom account; the agent asks you to sign in if it is missing."
          : "Scaffolds offline from the template bundled with the CLI. No account, no network."}
      </p>
    </div>
  );
}
