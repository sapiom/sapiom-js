/**
 * Test fixture — the same topology as the "order-triage" shape
 * scripts/seed-example.mjs scaffolds for demos (5 steps, 1 branch point, 2
 * terminal outcomes: one `terminate` and one that ALSO calls `terminate` but
 * with an escalation-flavored payload — deliberately kept, since it's
 * exactly what exercises the deterministic extractor's real limitation: it
 * classifies by declared transition kind (`terminal`/`canFail`), never by a
 * payload's runtime meaning, so this step renders as terminal-success like
 * any other `terminate`, not terminal-warn — see core/canvas-graph.test.ts).
 *
 * No `inputSchema` (no zod) unlike the real seed: this monorepo has two zod
 * majors installed across packages (a `@sapiom/agent` peer-dependency range
 * spanning 3.25.76–4.x), and esbuild resolves each bundled file's `zod`
 * import independently from that file's own location — a fixture's schema
 * and @sapiom/agent's own zod/v4 introspection can land on two different
 * physical zod instances and produce a bogus "reading 'def' of undefined"
 * once bundled together. Real consumer projects have a single zod install
 * and never hit this; it's purely a monorepo-fixture hazard, sidestepped by
 * not exercising `inputSchema` here (this extractor doesn't read it anyway).
 *
 * No package.json / own node_modules: esbuild resolves `@sapiom/agent` by
 * walking up to this package's own node_modules (a real workspace dependency
 * of @sapiom/harness), which also means `check()`'s typecheck step is
 * skipped here (no local tsc) — itself a case worth covering, distinct from
 * a workflow that genuinely fails to bundle.
 */
import { defineAgent, defineStep, goto, terminate } from "@sapiom/agent";

const intake = defineStep({
  name: "intake",
  next: ["classify"],
  async run(input) {
    return goto("classify", { order: input, receivedAt: new Date().toISOString() });
  },
});

const classify = defineStep({
  name: "classify",
  next: ["route"],
  async run(input: { order: { category?: string } }) {
    const category = input.order.category ?? "general";
    return goto("route", { ...input, category });
  },
});

const route = defineStep({
  name: "route",
  next: ["auto_resolve", "escalate"],
  async run(input: { category: string }) {
    const needsHuman = input.category === "billing_dispute";
    return goto(needsHuman ? "escalate" : "auto_resolve", input);
  },
});

const auto_resolve = defineStep({
  name: "auto_resolve",
  next: [],
  terminal: true,
  async run(input: { category: string }) {
    return terminate({ resolved: true, category: input.category });
  },
});

const escalate = defineStep({
  name: "escalate",
  next: [],
  terminal: true,
  async run() {
    return terminate({ resolved: false, escalated: true });
  },
});

export const agent = defineAgent({
  name: "order-triage",
  entry: "intake",
  steps: { intake, classify, route, auto_resolve, escalate },
});
