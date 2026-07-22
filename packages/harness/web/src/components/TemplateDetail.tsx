import type { JSX } from "react";

import { templateGraph, type GalleryTemplate, type StudioTemplate, type TemplateExample } from "../lib/templates";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

/**
 * The template's step structure, previewed with the canvas projections'
 * vocabulary (templateGraph → kind dots, elbow transition rows) before
 * anything is cloned. Pure manifest truth: the same nodes and edges the
 * canvas would map once the clone lands and Visualize runs.
 */
function TemplateGraphPreview({ template }: { template: GalleryTemplate }): JSX.Element {
  const graph = templateGraph(template);
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
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Pretty-printed example payload — the manifest's own JSON, verbatim. */
function ExampleBlock({ example }: { example: TemplateExample }): JSX.Element {
  return (
    <details className="template-example">
      <summary className="template-example-summary">{example.title}</summary>
      <div className="template-example-body">
        <span className="template-example-label">Input</span>
        <pre className="template-example-json">{JSON.stringify(example.input, null, 2)}</pre>
        <span className="template-example-label">Output</span>
        <pre className="template-example-json">{JSON.stringify(example.output, null, 2)}</pre>
      </div>
    </details>
  );
}

function GalleryDetail({ template }: { template: GalleryTemplate }): JSX.Element {
  return (
    <>
      <p className="template-lead">{template.whatItDoes}</p>

      <section className="template-section">
        <h4 className="template-section-title">Steps</h4>
        {/* Structure first (the canvas vocabulary), then the ordered list
            with each step's description. Same manifest, two readings. */}
        <TemplateGraphPreview template={template} />
        <ol className="template-steps">
          {template.steps.map((step, index) => (
            <li key={step.name} className="template-step">
              <span className="template-step-index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="template-step-copy">
                <span className="template-step-name">
                  {step.name}
                  {step.terminal && <span className="template-step-exit">exit</span>}
                </span>
                <span className="template-step-desc">{step.description}</span>
              </span>
              {step.capability && <code className="template-cap">{step.capability}</code>}
            </li>
          ))}
        </ol>
        <p className="template-note">Steps run in listed order; the first is the entry.</p>
      </section>

      <section className="template-section">
        <h4 className="template-section-title">Capabilities and cost</h4>
        {template.capabilities.length > 0 ? (
          <>
            <div className="template-caps">
              {template.capabilities.map((capability) => (
                <code key={capability} className="template-cap">
                  {capability}
                </code>
              ))}
            </div>
            {/* Honest absence: the backend computes the per-run estimate from
                this list, and no client surface exposes it yet.
                Never a fabricated figure. */}
            <p className="template-note" data-testid="template-cost-note">
              Metered capabilities set the per-run price. Sapiom estimates it from this list; the
              estimate is not surfaced here yet. Local test runs stub every capability and are free.
            </p>
          </>
        ) : (
          <p className="template-note" data-testid="template-cost-note">
            No metered capabilities, so runs record no capability cost.
          </p>
        )}
      </section>

      <section className="template-section">
        <h4 className="template-section-title">Use cases</h4>
        <ul className="template-usecases">
          {template.useCases.map((useCase) => (
            <li key={useCase}>{useCase}</li>
          ))}
        </ul>
      </section>

      <section className="template-section">
        <h4 className="template-section-title">Examples</h4>
        {template.examples.map((example) => (
          <ExampleBlock key={example.title} example={example} />
        ))}
      </section>

      <section className="template-section">
        <h4 className="template-section-title">Notes</h4>
        <div className="template-notes">
          <Markdown text={template.notes} />
        </div>
      </section>
    </>
  );
}

/**
 * The preview pane of the templates dialog: real manifest fields only. A
 * gallery template renders its registry entry + template.json detail; a
 * starter renders the one honest sentence the scaffold tool ships about it —
 * bundled starters have no manifest, so nothing more is claimed.
 */
export function TemplateDetail({ template }: { template: StudioTemplate }): JSX.Element {
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
          <span className="template-byline">
            By{" "}
            <a href={template.author.url} target="_blank" rel="noopener noreferrer">
              {template.author.name}
            </a>
          </span>
          <GalleryDetail template={template} />
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
