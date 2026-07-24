import { useState } from "react";
import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import { generateSnippet } from "../lib/generate-snippet";

/** Sapiom dashboard page where a user mints/manages the tenant API key that the
 *  snippet's `YOUR_SAPIOM_API_KEY` placeholder stands in for. Needed to run a
 *  deployed agent from outside the Studio (the Studio's own session key is not
 *  a copy-pasteable credential for a user's code). */
const SAPIOM_API_KEYS_URL = "https://app.sapiom.ai/settings?tab=api-keys";

/**
 * `WorkflowInfo.definitionSlug` (resolved from the deployment) and
 * `AppState.agentsBaseUrl` (from the server's env) are both part of the
 * canonical shared contract, so the panel reads them directly. It still falls
 * back client-side when they are absent: the project name for the slug (flagged
 * as inferred) when `definitionSlug` is null, and the SDK's default host for
 * the base URL when `agentsBaseUrl` is undefined (older servers / mocks).
 */
interface SnippetPanelProps {
  /** The workflow currently bound to the active session. */
  boundWorkflow: WorkflowInfo;
  /** The Agents API base URL (from AppState) — the executions host the snippet
   *  targets, so it matches where the server resolved the slug. Undefined on
   *  servers that predate the field (and in mocks), where generateSnippet
   *  falls back to the SDK's default host. */
  agentsBaseUrl?: string;
}

type SnippetTab = "typescript" | "curl";

/**
 * "Trigger from your code" panel — shown under the canvas subheader whenever
 * the bound workflow is deployed (definitionId != null). Provides copy-paste
 * TypeScript SDK and cURL snippets for the deployed agent.
 *
 * The slug is READ-ONLY: it is the deployed agent's stable handle
 * (`defineAgent({ name })`, cached in sapiom.json) and the executions-API
 * identity — NOT something you rename here. Editing it would only make the
 * snippet call a non-existent agent (404). To rename an agent, change its
 * `defineAgent` name in code and redeploy.
 */
export function SnippetPanel({ boundWorkflow, agentsBaseUrl }: SnippetPanelProps): JSX.Element | null {
  // Guard: only render when the workflow is deployed.
  if (boundWorkflow.definitionId == null) return null;

  return <SnippetPanelInner boundWorkflow={boundWorkflow} agentsBaseUrl={agentsBaseUrl} />;
}

// Split into an inner component so hooks are always called after the null-guard
// without the React-hooks-in-conditionals lint error.
function SnippetPanelInner({ boundWorkflow, agentsBaseUrl }: SnippetPanelProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<SnippetTab>("typescript");
  const [copied, setCopied] = useState(false);

  // The slug is the deployed agent's stable handle — never user-edited. Prefer
  // the slug resolved from the deployment (definitionSlug); when that lookup
  // hasn't resolved (older servers, or the harness isn't signed into the
  // account that owns the agent), fall back to the project's own name — for a
  // conventionally named agent project that IS the slug, far better than a
  // fill-in placeholder sitting in a read-only field. `slugInferred` drives
  // the "verify this" note shown only in that fallback case.
  const slugInferred = boundWorkflow.definitionSlug == null;
  const slug = boundWorkflow.definitionSlug ?? boundWorkflow.name;
  const { typescript, curl } = generateSnippet({ definition: slug, baseUrl: agentsBaseUrl });
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
        <span className="snippet-slug-label">Agent</span>
        <code className="snippet-slug" data-testid="snippet-slug">
          {slug}
        </code>
      </div>
      {slugInferred && (
        <p className="snippet-slug-inferred" data-testid="snippet-slug-inferred">
          Inferred from the project name. Confirm it matches your deployed agent.
        </p>
      )}

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
        Replace <code>YOUR_SAPIOM_API_KEY</code> with a key from your{" "}
        <a
          className="snippet-link"
          data-testid="snippet-api-key-link"
          href={SAPIOM_API_KEYS_URL}
          target="_blank"
          rel="noreferrer"
        >
          Sapiom dashboard
        </a>
        . Add <code>idempotencyKey</code> to the body to deduplicate retries.
      </p>
    </div>
  );
}
