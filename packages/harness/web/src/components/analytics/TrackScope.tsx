import type { ReactNode } from "react";

import { type TrackingContext, trackingAttrs } from "../../lib/analytics/tracking-attrs";

/**
 * Attribute an entire subtree for autocapture without an `onClick` at every leaf
 * (SAP-1988; ported from the web app's `TrackScope`).
 *
 * Renders a `display: contents` wrapper carrying `data-ph-capture-attribute-*`,
 * so posthog-js inherits the context onto every click beneath it while the
 * wrapper itself adds no box to the layout. Prefer spreading {@link trackingAttrs}
 * directly onto an element you already have; reach for `TrackScope` only when you
 * need to wrap a group that has no single natural host element.
 */
export function TrackScope({
  children,
  ...context
}: TrackingContext & { children: ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: "contents" }} {...trackingAttrs(context)}>
      {children}
    </div>
  );
}
