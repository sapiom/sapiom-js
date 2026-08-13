import type { JSX } from "react";

import { BrandLogotypePixel, BrandMarkPixel } from "./BrandPixel";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

interface TerminalBrandProps {
  /** Working directory this session is rooted in, when the app knows it. */
  cwd?: string | null;
  /** Shown while the socket is not connected; omitted once it is. */
  status?: string | null;
  /** Version legend on the frame's top edge (e.g. "v0.2.5"), from the build. */
  version?: string | null;
}

/**
 * The terminal's boot banner in the shape a CLI actually uses — one ruled box,
 * titled on its top edge, the Sapiom brand on the left and a small table of
 * facts on the right. It replaces the agent CLI's own welcome box so the shell
 * names ITSELF here (Sapiom agent.studio), not the underlying model. The mark
 * is the only thing at mascot scale and renders as pixel art; both mark and
 * wordmark are the shared official assets, in ink (currentColor), never green.
 */
export function TerminalBrand({ cwd, status, version }: TerminalBrandProps): JSX.Element {
  return (
    <section className="terminal-masthead" data-status={status ? "degraded" : undefined} aria-label="Session banner">
      {version && (
        <h2 className="terminal-masthead-legend">
          <span className="visually-hidden">Sapiom agent.studio </span>
          {version}
        </h2>
      )}

      <div className="terminal-masthead-brand">
        <BrandMarkPixel cell={3} className="terminal-masthead-mark" />
        <span className="terminal-masthead-name" aria-label="Sapiom agent.studio">
          <BrandLogotypePixel cell={1} className="terminal-masthead-logotype" />
          <span className="terminal-masthead-product" aria-hidden="true">
            agent.studio
          </span>
        </span>
      </div>

      <dl className="terminal-masthead-facts">
        {cwd && (
          // `cwd` is an absolute path — it contains the OS username.
          <div className="terminal-masthead-fact" {...trackingAttrs({ object: "workspace" })}>
            <dt>dir</dt>
            <dd className="terminal-masthead-path" title={cwd}>
              {cwd}
            </dd>
          </div>
        )}
        <div className="terminal-masthead-fact">
          <dt>tip</dt>
          <dd>
            run <code>npx @sapiom/harness</code> for a real, PTY-backed session
          </dd>
        </div>
        {status && (
          <div className="terminal-masthead-fact">
            <dt>status</dt>
            <dd className="terminal-masthead-status">{status}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
