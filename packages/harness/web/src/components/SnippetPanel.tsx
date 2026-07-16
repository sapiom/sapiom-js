import { useState } from "react";
import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import { generateSnippet } from "../lib/generate-snippet";

interface SnippetPanelProps {
  /** The workflow currently bound to the active session. */
  boundWorkflow: WorkflowInfo;
}

type SnippetTab = "typescript" | "curl";

/**
 * "Trigger from your code" panel — shown below the canvas header whenever the
 * bound workflow is deployed (definitionId != null). Provides copy-paste
 * TypeScript SDK and cURL snippets pre-filled with the deployed agent's slug.
 * The slug is editable so users can correct it if it differs from what's in
 * sapiom.json, or fill it in manually when the slug is not yet known.
 */
export function SnippetPanel({ boundWorkflow }: SnippetPanelProps): JSX.Element | null {
  // Guard: only render when the workflow is deployed.
  if (boundWorkflow.definitionId == null) return null;

  return <SnippetPanelInner boundWorkflow={boundWorkflow} />;
}

// Split into an inner component so hooks are always called after the null-guard
// without the React-hooks-in-conditionals lint error.
function SnippetPanelInner({ boundWorkflow }: SnippetPanelProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<SnippetTab>("typescript");
  const [slug, setSlug] = useState<string>(boundWorkflow.definitionSlug ?? "");
  const [copied, setCopied] = useState(false);

  // Effective slug: prefer what the user typed; fall back to placeholder string
  // in the generated output so there's always something meaningful to copy.
  const effectiveSlug = slug.trim() || "your-agent-slug";
  const { typescript, curl } = generateSnippet({ definition: effectiveSlug });
  const activeSnippet = activeTab === "typescript" ? typescript : curl;

  const handleCopy = (): void => {
    navigator.clipboard
      .writeText(activeSnippet)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Clipboard blocked (e.g. a non-secure context) — leave the button as
        // "Copy" rather than falsely confirming; never throw into the UI.
      });
  };

  return (
    <div className="snippet-panel" data-testid="snippet-panel">
      <div className="snippet-panel-header">
        <span className="snippet-panel-title">Trigger from your code</span>
      </div>

      <div className="snippet-slug-row">
        <label className="snippet-slug-label" htmlFor="snippet-slug-input">
          Agent slug
        </label>
        <input
          id="snippet-slug-input"
          className="snippet-slug-input"
          data-testid="snippet-slug-input"
          type="text"
          value={slug}
          placeholder="your-agent-slug"
          onChange={(e) => setSlug(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="snippet-tabs" role="tablist" aria-label="Snippet language">
        <button
          role="tab"
          aria-selected={activeTab === "typescript"}
          aria-controls="snippet-code-panel"
          className={"snippet-tab" + (activeTab === "typescript" ? " is-active" : "")}
          data-testid="snippet-tab-ts"
          onClick={() => setActiveTab("typescript")}
        >
          TypeScript (SDK)
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "curl"}
          aria-controls="snippet-code-panel"
          className={"snippet-tab" + (activeTab === "curl" ? " is-active" : "")}
          data-testid="snippet-tab-curl"
          onClick={() => setActiveTab("curl")}
        >
          cURL (HTTP)
        </button>
      </div>

      <div className="snippet-code-wrap" role="tabpanel" id="snippet-code-panel">
        <pre className="snippet-code" data-testid="snippet-code">
          <code>{activeSnippet}</code>
        </pre>
        <button
          className={"snippet-copy" + (copied ? " is-copied" : "")}
          data-testid="snippet-copy"
          aria-label={copied ? "Copied" : "Copy snippet"}
          onClick={handleCopy}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <p className="snippet-hint">
        Optionally add <code>idempotencyKey</code> to the body to deduplicate retries.
      </p>
    </div>
  );
}
