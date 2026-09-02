import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";

import { beforeSend } from "./before-send";

/**
 * The redaction gate.
 *
 * The per-rule tests in `before-send.test.ts` check that each mechanism does
 * what it says. This file checks the thing we actually care about: that a
 * realistic click on a name-bearing surface emits NOTHING identifying — no
 * agent name, no folder name, no absolute path (which carries the OS
 * username).
 *
 * It exists because the first version of this instrumentation passed 33 green
 * tests while leaking the agent name on every rail click. The tests asserted
 * that `attr__class` survived and that `$el_text` was gone, and never looked at
 * `attr__data-testid` — which this codebase interpolates with the very names
 * being redacted (`data-testid={`workflow-${workflow.name}`}`). Every rule was
 * individually correct; the payload still carried the name.
 *
 * So this gate asserts on the WHOLE payload with a needle, rather than on
 * fields a test author remembered to check. If a new attribute, a new carrier,
 * or a new component starts carrying user data, the needle shows up here.
 */

/** Fixture values chosen to be unmistakable if they ever survive. */
const AGENT = "acme-client-secret";
const FOLDER = "quarterly-revenue";
const FILE = "confidential-acquisition-plan.pdf";
const ABS_PATH = "/Users/jrandom/code/quarterly-revenue";
const NEEDLES = [AGENT, FOLDER, FILE, ABS_PATH, "/Users/", "jrandom"];

function capture(properties: Record<string, unknown>): CaptureResult {
  return { event: "$autocapture", properties } as CaptureResult;
}

/** Everything the event would carry, flattened to one string for needle search. */
function payloadText(result: CaptureResult | null): string {
  return JSON.stringify(result ?? {});
}

function expectNoLeak(result: CaptureResult | null): void {
  const text = payloadText(result);
  for (const needle of NEEDLES) {
    expect(text, `payload leaked ${JSON.stringify(needle)}: ${text}`).not.toContain(needle);
  }
}

describe("redaction gate — realistic clicks must not carry user names or paths", () => {
  // Shapes below mirror the real markup of each component as posthog-js
  // serializes it: `$elements` objects AND the `$elements_chain` string, since
  // remote config decides which one is sent.

  it("agent row in the rail (WorkflowRow, object=agent)", () => {
    expectNoLeak(
      beforeSend(
        capture({
          object: "agent",
          surface: "agent_rail",
          $el_text: AGENT,
          $elements: [
            {
              tag_name: "button",
              attr__class: "tree-row workflow-item-trigger",
              [`attr__data-testid`]: `workflow-${AGENT}`,
              attr__title: AGENT,
              $el_text: AGENT,
            },
            { tag_name: "div", attr__class: "workflow-item", [`attr__data-testid`]: `workflow-${AGENT}` },
          ],
          $elements_chain:
            `button.tree-row:attr__class="tree-row"attr__data-testid="workflow-${AGENT}"attr__title="${AGENT}"text="${AGENT}"nth-child="1";` +
            `div.workflow-item:attr__class="workflow-item"attr__data-testid="workflow-${AGENT}"nth-child="1"`,
        }),
      ),
    );
  });

  it("workspace row in the rail — title is the ABSOLUTE PATH (object=workspace)", () => {
    expectNoLeak(
      beforeSend(
        capture({
          object: "workspace",
          surface: "agent_rail",
          $el_text: FOLDER,
          $elements: [
            {
              tag_name: "button",
              attr__class: "workspace-row-main",
              attr__title: ABS_PATH,
              [`attr__aria-label`]: `Focus ${FOLDER}`,
              $el_text: FOLDER,
            },
          ],
          $elements_chain:
            `button.workspace-row-main:attr__class="workspace-row-main"attr__title="${ABS_PATH}"` +
            `attr__aria-label="Focus ${FOLDER}"attr__data-testid="workspace-focus-${FOLDER}"text="${FOLDER}"nth-child="1"`,
        }),
      ),
    );
  });

  it("copy-path icon button — icon-only, so the name is ONLY in the aria-label", () => {
    // This is the promotion trap: no visible text, and the accessible name
    // interpolates the folder. Without the `object` tag, promotion would copy
    // it straight into $el_text.
    expectNoLeak(
      beforeSend(
        capture({
          object: "workspace",
          surface: "agent_rail",
          $elements_chain:
            `svg.lucide:attr__aria-hidden="true"nth-child="1";` +
            `button.workspace-row-copy:attr__class="workspace-row-copy"attr__aria-label="Copy path for ${FOLDER}"nth-child="2"`,
        }),
      ),
    );
  });

  it("canvas actions header — agent name in text and title (object=agent)", () => {
    expectNoLeak(
      beforeSend(
        capture({
          object: "agent",
          surface: "canvas",
          $el_text: AGENT,
          $elements_chain:
            `span.workflow-actions-name:attr__class="workflow-actions-name"attr__title="${AGENT}"text="${AGENT}"nth-child="1";` +
            `div.workflow-actions-header:attr__class="workflow-actions-header"attr__data-testid="workflow-actions-header"nth-child="1"`,
        }),
      ),
    );
  });

  it("Agent Map connector node — name in text and aria-label (object=agent)", () => {
    expectNoLeak(
      beforeSend(
        capture({
          object: "agent",
          surface: "agent_map",
          $el_text: AGENT,
          $elements: [
            {
              tag_name: "button",
              attr__class: "agent-map-node",
              [`attr__aria-label`]: `${AGENT}, connector, Proposed`,
              $el_text: AGENT,
            },
          ],
          $elements_chain:
            `span.system-graph-node-label:attr__class="system-graph-node-label"text="${AGENT}"nth-child="1";` +
            `button.agent-map-node:attr__class="agent-map-node"attr__aria-label="${AGENT}, connector, Proposed"text="${AGENT}"nth-child="1";` +
            `div.agent-map-live:attr__class="agent-map-live"nth-child="1"`,
        }),
      ),
    );
  });

  it("terminal masthead — cwd rendered as text AND title (object=workspace)", () => {
    expectNoLeak(
      beforeSend(
        capture({
          object: "workspace",
          surface: "terminal",
          $el_text: ABS_PATH,
          $elements_chain: `dd.terminal-masthead-path:attr__class="terminal-masthead-path"attr__title="${ABS_PATH}"text="${ABS_PATH}"nth-child="1"`,
        }),
      ),
    );
  });

  it("session bar menu — cwd embedded in a data-tooltip (object=session)", () => {
    expectNoLeak(
      beforeSend(
        capture({
          object: "session",
          surface: "session_bar",
          $elements_chain: `button.session-menu:attr__class="session-menu"attr__data-tooltip="Claude Code · ${FOLDER} · ${ABS_PATH}"nth-child="1"`,
        }),
      ),
    );
  });

  it("recent-folder chip (object=directory)", () => {
    expectNoLeak(
      beforeSend(
        capture({
          object: "directory",
          $el_text: FOLDER,
          $elements_chain: `button.recent-dir-chip:attr__class="recent-dir-chip"attr__title="${ABS_PATH}"text="${FOLDER}"nth-child="1"`,
        }),
      ),
    );
  });

  it("composer attachment row (object=file)", () => {
    expectNoLeak(
      beforeSend(
        capture({
          object: "file",
          surface: "composer",
          $el_text: FILE,
          $elements_chain:
            `button.composer-file-remove:attr__class="composer-file-remove"attr__aria-label="Remove ${FILE}"nth-child="1";` +
            `li.composer-file:attr__class="composer-file"text="${FILE}"nth-child="1"`,
        }),
      ),
    );
  });

  it("holds even on an UNTAGGED surface, for everything but the visible label", () => {
    // The allowlist is what makes a missing `object` tag survivable: attributes
    // are dropped regardless, so a component nobody tagged still cannot ship a
    // path or a testid-embedded name. Only `$el_text` — the label the author
    // chose to render — depends on the tag.
    const out = beforeSend(
      capture({
        surface: "some_new_surface",
        $elements: [{ attr__class: "row", [`attr__data-testid`]: `workflow-${AGENT}`, attr__title: ABS_PATH }],
        $elements_chain: `div.row:attr__class="row"attr__data-testid="workflow-${AGENT}"attr__title="${ABS_PATH}"nth-child="1"`,
      }),
    );
    expectNoLeak(out);
    // …and the useful structure is still there for Actions and heatmaps.
    expect(payloadText(out)).toContain("row");
  });

  it("keeps the class/id skeleton that heatmaps and Actions match on", () => {
    const out = beforeSend(
      capture({
        object: "agent",
        $elements: [{ attr__class: "tree-row", attr__id: "agent-row", [`attr__data-testid`]: `workflow-${AGENT}` }],
        $elements_chain: `button.tree-row:attr__class="tree-row"attr__id="agent-row"nth-child="1"`,
      }),
    );
    const el = (out!.properties as { $elements: Record<string, unknown>[] }).$elements[0];
    expect(el.attr__class).toBe("tree-row");
    expect(el.attr__id).toBe("agent-row");
    expect(el["attr__data-testid"]).toBeUndefined();
    expect((out!.properties as Record<string, unknown>).$elements_chain).toContain('nth-child="1"');
  });

  it("survives quotes in a name — posthog escapes them as \\\" inside the chain", () => {
    const quoted = 'my "cool" agent';
    const out = beforeSend(
      capture({
        object: "agent",
        $elements_chain: `button.tree-row:attr__class="tree-row"text="my \\"cool\\" agent"nth-child="1"`,
      }),
    );
    expect(payloadText(out)).not.toContain("cool");
    expect(quoted).toContain("cool"); // guards the needle itself from typos
  });

  it("promotes an accessible name containing an escaped quote in full", () => {
    // Same escape-awareness, on the promotion path. A plain `[^"]*` stops at
    // the first `\"` and promotes a truncated label.
    const out = beforeSend(
      capture({
        $elements_chain: `button.copy:attr__class="copy"attr__aria-label="Copy the \\"raw\\" output"nth-child="1"`,
      }),
    );
    expect((out!.properties as Record<string, unknown>).$el_text).toBe('Copy the \\"raw\\" output');
  });

  it("drops attr__href entirely rather than sanitizing it", () => {
    // Deliberate capability change: link destinations no longer reach PostHog
    // in any mode. `$el_text` still carries the visible label on `truncate`
    // surfaces, so most link analysis survives. Documented in the PR body.
    const out = beforeSend(
      capture({
        $el_text: "Open dashboard",
        $elements: [{ attr__class: "link", attr__href: "https://app.sapiom.ai/agents/123?token=secret" }],
        $elements_chain: `a.link:attr__class="link"attr__href="https://app.sapiom.ai/agents/123?token=secret"nth-child="1"`,
      }),
    );
    const text = payloadText(out);
    expect(text).not.toContain("token=secret");
    expect(text).not.toContain("attr__href");
    expect((out!.properties as Record<string, unknown>).$el_text).toBe("Open dashboard");
  });
});

/**
 * Static tripwire for the one hole the allowlist cannot close.
 *
 * Attributes are now safe by construction, but `$el_text` and the accessible
 * name still depend on a human remembering to tag the surface. This scans the
 * components for an `aria-label` built by interpolation and requires the file
 * to tag something — so "add a component, forget the tag entirely" fails here
 * rather than in production.
 *
 * ## What this does NOT catch
 *
 * It is deliberately file-level, and that is a real limit, not a rounding
 * error: a component with two render branches passes as soon as ONE of them
 * tags an object. That exact case existed while writing this —
 * `WorkflowActionsHeader` tags its steps branch and its detail branch
 * separately, and a file-level check would have waved the second one through.
 *
 * It also only recognises TEMPLATE-LITERAL labels — ``aria-label={`…${x}`}``.
 * `aria-label={"Focus " + label}` and `aria-label={computeLabel(x)}` pass
 * silently. Neither form exists in the tree today, so this is about what the
 * check promises rather than a live gap, but it is the obvious way to slip
 * past it.
 *
 * Closing both properly needs a rendered DOM, which this runner does not have
 * (see vitest.config.ts: React components are the Playwright tier's job). The
 * durable version belongs in `web/e2e` — render each surface with a fixture
 * path and assert every element whose attributes contain it has an ancestor
 * carrying a USER_NAMED_OBJECTS tag. Until then: this catches the coarse case,
 * the payload gate above catches the mechanism, and neither substitutes for
 * reading the diff.
 *
 * The allowlist below is the escape hatch, and it is deliberately annotated:
 * adding to it should require saying out loud why the interpolated value is
 * ours rather than the user's.
 */
const SAFE_INTERPOLATED_LABELS: Record<string, string> = {
  "SessionStepsBar.tsx": "`Preview :${preview.port}` — a port number the server chose.",
  "TemplateUseDialog.tsx": "`Use ${template.name}` — a gallery template name from OUR registry.",
  "TemplateCard.tsx":
    "`What ${template.name} runs and costs` — GalleryTemplate, served by GET /api/templates. " +
    "Ours, low-cardinality, and the label that makes the on-ramp funnel readable.",
  "CanvasOverviewPanel.tsx": "Static labels only; interpolation is over our own counts.",
  "SchemaInputFields.tsx": "`Remove item ${index + 1}` — a list position, not a name.",
};

describe("components that build an aria-label by interpolation must tag their surface", () => {
  const componentsDir = fileURLToPath(new URL("../../components", import.meta.url));

  // Recursive: the point of this check is the component nobody thought about,
  // and "someone adds components/rail/WorkspaceRow.tsx" is exactly that. Node
  // 20+ per the CI test matrix.
  const offenders = readdirSync(componentsDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx"))
    .map((file) => ({
      file: file.split(/[\\/]/).pop() ?? file,
      source: readFileSync(`${componentsDir}/${file}`, "utf8"),
    }))
    .filter(({ source }) => /aria-label=\{`[^`]*\$\{/.test(source));

  it("finds the interpolating components at all (guards the regex itself)", () => {
    expect(offenders.length).toBeGreaterThan(0);
  });

  for (const { file, source } of offenders) {
    it(`${file} tags an object, or is explicitly known-safe`, () => {
      if (SAFE_INTERPOLATED_LABELS[file]) {
        expect(SAFE_INTERPOLATED_LABELS[file]).not.toBe("");
        return;
      }
      expect(
        /object:\s*"/.test(source),
        `${file} interpolates a value into an aria-label but sets no \`object\`. ` +
          `before-send would promote that label into $el_text verbatim. Tag the ` +
          `name-bearing element with an object from USER_NAMED_OBJECTS, or add ${file} ` +
          `to SAFE_INTERPOLATED_LABELS with a reason.`,
      ).toBe(true);
    });
  }
});
