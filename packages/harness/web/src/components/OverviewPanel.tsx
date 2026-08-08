import type { JSX } from "react";

import { BrandLogotype } from "./BrandLogotype";
import { Icon } from "./Icon";
import { SAPIOM_AGENTS_URL, SAPIOM_QUICKSTART_URL } from "../lib/urls";

/**
 * The Overview — a calm, self-contained introduction to Agent Studio, reached
 * from the account menu's "Overview" item.
 *
 * It is a DESTINATION, not a dialog or an overlay: like TemplatesPanel it stands
 * in for the workbench (`.app.is-browsing` hides the panes) and brings its own
 * top bar with the way back. It exists to answer one question for someone who
 * has just opened the app — "what is this, and how do I use it?" — so it names
 * the whole loop (build locally with your coding agent → shape it on the Canvas
 * → deploy and run it on the Sapiom cloud) and then lists what's in the window.
 *
 * Voice: overview, not a pitch. Sentence case, terse, second person, honest
 * about cost. The one brand flourish is the scarce green (`--brand`): it tints
 * only the three "how it works" glyphs — the narrative spine — while every
 * feature-card glyph stays neutral, matching the app's rule that green is a
 * deliberate accent, never chrome.
 */

interface OverviewStep {
  icon: string;
  title: string;
  body: string;
}

/** The build → shape → ship loop, in the app's own vocabulary. */
const STEPS: readonly OverviewStep[] = [
  {
    icon: "SquareTerminal",
    title: "Build it locally",
    body: "Describe the outcome you want. Your coding agent — Claude Code or Codex — scaffolds and authors a real Sapiom agent right in your workspace, pre-wired to Sapiom's tools.",
  },
  {
    icon: "Workflow",
    title: "Shape it on the Canvas",
    body: "Watch the agent take shape as a graph of steps. Click into any one, iterate in the terminal, and test-run it locally against stubs — no cost.",
  },
  {
    icon: "CloudUpload",
    title: "Run it on Sapiom",
    body: "Ship it to the Sapiom cloud in one action, then run and trigger it — on demand, on a schedule, or via API — and track every run on your dashboard.",
  },
];

interface OverviewFeature {
  icon: string;
  title: string;
  body: string;
}

/** What's actually in the window. Grounded in the app's own README. */
const FEATURES: readonly OverviewFeature[] = [
  {
    icon: "SquareTerminal",
    title: "Your coding agent, embedded",
    body: "Claude Code or Codex runs in a terminal here — your subscription, your machine. Studio only wires it up to Sapiom.",
  },
  {
    icon: "Folder",
    title: "Agents rail",
    body: "Every agent project in your workspace, discovered and tracked, with test, deploy, and production run one click away.",
  },
  {
    icon: "Workflow",
    title: "Canvas",
    body: "A live pane renders your agent's step graph, the docs it writes, and previews of any dev server it starts.",
  },
  {
    icon: "LayoutTemplate",
    title: "Templates",
    body: "Start from a runnable agent in the gallery instead of a blank folder — forked into a repo you own.",
  },
  {
    icon: "CloudUpload",
    title: "Deploy to the cloud",
    body: "One action bundles, validates the manifest and graph, and ships your agent to the Sapiom engine.",
  },
  {
    icon: "Zap",
    title: "Run in production",
    body: "Trigger and schedule deployed agents on Sapiom, then open any of them in your dashboard.",
  },
  {
    icon: "Sparkles",
    title: "Sapiom capabilities",
    body: "Agents call metered Sapiom tools — sandboxes, git repos, coding models, web search, and storage.",
  },
  {
    icon: "Check",
    title: "Zero config mutation",
    body: "Everything is injected per session; your global coding-agent settings are never touched.",
  },
];

interface OverviewPanelProps {
  /** Genuine first run: warms the eyebrow to a welcome and surfaces the
   *  quick-start a newcomer needs, matching the composer home's first-run beat. */
  firstRun: boolean;
  /** Signed in to Sapiom — gates the honest "sign in to deploy" hint. */
  authenticated: boolean;
  /** The desktop build, shown quietly in the footer. Null in the browser host. */
  appVersion?: string | null;
  /** Leave the Overview and return to the workbench. */
  onExit: () => void;
  /** The primary action: open the composer-first "new session" home. */
  onCreateNew: () => void;
  /** The other on-ramp: browse the template catalog. */
  onBrowseTemplates: () => void;
}

export function OverviewPanel({
  firstRun,
  authenticated,
  appVersion,
  onExit,
  onCreateNew,
  onBrowseTemplates,
}: OverviewPanelProps): JSX.Element {
  return (
    <section className="overview-panel" data-testid="overview-panel" aria-label="Overview">
      {/* Same height as the session bar it stands in for, so the shell's top
          edge does not shift as you enter and leave. */}
      <div className="overview-bar">
        <button
          type="button"
          className="theme-toggle overview-back"
          data-testid="overview-exit"
          aria-label="Back to the session"
          title="Back to the session"
          onClick={onExit}
        >
          <Icon name="ArrowLeft" size={14} />
        </button>
        <span className="overview-bar-title">Overview</span>
        <a
          className="btn-line overview-bar-dash"
          data-testid="overview-open-dashboard"
          href={SAPIOM_AGENTS_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Sapiom dashboard
          <Icon name="ExternalLink" size={13} />
        </a>
      </div>

      <div className="overview-scroll">
        <div className="overview-measure">
          <header className="overview-hero">
            {/* The in-app lockup, verbatim: the wordmark IS "Sapiom", so the S
                mark is never placed beside it; the product name is lowercase
                mono, matching the rail header and terminal masthead. */}
            <span className="overview-lockup">
              <BrandLogotype height={13} aria-label="Sapiom" />
              <span className="overview-lockup-product">agent.studio</span>
            </span>
            <p className="overview-eyebrow">
              {firstRun ? "Welcome to Agent Studio." : "Agent Studio, in one screen."}
            </p>
            <h1 className="overview-hero-title">
              Build agents with your coding agent. Run them on Sapiom.
            </h1>
            <p className="overview-hero-copy">
              Agent Studio pairs Claude Code or Codex — running in an embedded terminal on
              your machine — with the Sapiom cloud. Describe an outcome, watch the agent
              take shape on the Canvas, then deploy and run it in production.
            </p>
            <div className="overview-hero-actions">
              <button
                type="button"
                className="btn-primary overview-cta"
                data-testid="overview-create-new"
                onClick={onCreateNew}
              >
                <Icon name="Plus" size={14} />
                Build an agent
              </button>
              <button
                type="button"
                className="btn-line overview-cta"
                data-testid="overview-browse-templates"
                onClick={onBrowseTemplates}
              >
                <Icon name="LayoutTemplate" size={14} />
                Start from a template
              </button>
            </div>
            {!authenticated && (
              <p className="overview-signin-hint" data-testid="overview-signin-hint">
                <Icon name="Info" size={13} />
                Sign in to Sapiom from the account menu to deploy and run agents in the cloud.
              </p>
            )}
          </header>

          <section className="overview-steps">
            <h2 className="overview-section-title">How it works</h2>
            <ol className="overview-steps-list">
              {STEPS.map((step, index) => (
                <li key={step.title} className="overview-step">
                  <span className="overview-step-glyph" aria-hidden="true">
                    <Icon name={step.icon} size={18} />
                  </span>
                  <span className="overview-step-copy">
                    <span className="overview-step-title">
                      <span className="overview-step-index">{index + 1}</span>
                      {step.title}
                    </span>
                    <span className="overview-step-body">{step.body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="overview-features">
            <h2 className="overview-section-title">What's in the window</h2>
            <div className="overview-feature-grid">
              {FEATURES.map((feature) => (
                <div key={feature.title} className="overview-feature">
                  <span className="overview-feature-glyph" aria-hidden="true">
                    <Icon name={feature.icon} size={16} />
                  </span>
                  <span className="overview-feature-title">{feature.title}</span>
                  <span className="overview-feature-body">{feature.body}</span>
                </div>
              ))}
            </div>
          </section>

          <footer className="overview-foot">
            <a
              className="overview-foot-link"
              data-testid="overview-quickstart"
              href={SAPIOM_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="BookOpen" size={13} />
              Read the quick start
              <Icon name="ArrowUpRight" size={12} />
            </a>
            {appVersion && (
              <span className="overview-foot-version" data-testid="overview-version">
                agent.studio v{appVersion}
              </span>
            )}
          </footer>
        </div>
      </div>
    </section>
  );
}
