/**
 * Templates journey v0 (browse → preview → use), all in mock mode.
 *
 * Ground truth this exercises: the gallery is FETCHED (GET /api/templates, which
 * the server relays from core) rather than pinned in lib/templates.ts, only the
 * bundled starters are local, the preview renders only real manifest fields, and
 * "Use template" performs the REAL handoff shape — a session at the destination folder plus the agent
 * prompt naming sapiom_dev_agents_clone (gallery) or `sapiom agents init -t`
 * (bundled starter). MockApi records the injection on
 * window.__HARNESS_TEST__.lastInjectInput for the clone assertions.
 */
import { expect, test } from "@playwright/test";

interface InjectRecord {
  id: string;
  req: { text: string; submit?: boolean };
}

const lastInject = (page: import("@playwright/test").Page): Promise<InjectRecord | undefined> =>
  page.evaluate(
    () =>
      (window as unknown as { __HARNESS_TEST__?: { lastInjectInput?: unknown } }).__HARNESS_TEST__
        ?.lastInjectInput as InjectRecord | undefined,
  );

test.describe("templates journey v0 (from the welcome panel)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.getByTestId("welcome-panel")).toBeVisible();
    await page.getByTestId("welcome-browse-templates").click();
    await expect(page.getByTestId("templates-dialog")).toBeVisible();
  });

  test("browse: catalog templates plus the two bundled starters", async ({
    page,
  }) => {
    // Real clonable slugs from the catalog, not a hardcoded pair.
    await expect(page.getByTestId("template-row-web-research-digest")).toBeVisible();
    await expect(page.getByTestId("template-row-hello-agent")).toBeVisible();
    await expect(page.getByTestId("template-row-default")).toBeVisible();
    await expect(page.getByTestId("template-row-coding-pause")).toBeVisible();

    await page.screenshot({ path: "web/e2e/screenshots/templates-dialog.png", fullPage: true });
  });

  test("preview: real registry metadata — ordered steps, capability, tags, author", async ({ page }) => {
    await page.getByTestId("template-row-web-research-digest").click();
    const detail = page.getByTestId("template-detail");
    await expect(detail).toContainText("Web Research Digest");
    await expect(detail).toContainText("By");
    await expect(detail).toContainText("Sapiom");

    // Steps render in declared order, each labelled with the role the SHARED
    // classifier assigned (classifyStepKind) rather than a terminal-or-not guess:
    // the entry says "entry", a terminate-only sink says "terminal · success".
    const stepNames = detail.locator(".template-step-name");
    await expect(stepNames.nth(0)).toContainText("search");
    await expect(stepNames.nth(0)).toContainText("entry");
    await expect(stepNames.nth(1)).toContainText("summarize");
    await expect(stepNames.nth(1)).toContainText("terminal · success");
    await expect(detail.locator(".template-cap").first()).toContainText("web.search");
  });

  test("preview: the band core served, explained by what produced it — and never a price", async ({ page }) => {
    // Replaced a per-run cost estimate core no longer computes (SAP-2085). The
    // band is shown with the counts behind it, so it reads as an estimate of
    // shape rather than an opaque verdict.
    await page.getByTestId("template-row-dependency-upgrade").click();
    const note = page.getByTestId("template-complexity-note");
    await expect(note).toContainText("Advanced 5/5");
    await expect(note).toContainText("2 model steps, 1 chained");
    // Nothing on this surface may read as money any more.
    expect(await note.textContent()).not.toMatch(/\$/);

    // A deterministic saga: the largest graph in the catalog, and still Simple.
    // The scorer weighs judgment, not topology — the point of the band.
    await page.getByTestId("template-row-approval-chain").click();
    await expect(page.getByTestId("template-complexity-note")).toContainText("Simple 2/5");
    await expect(page.getByTestId("template-complexity-note")).toContainText("deterministic");

    // No band in the payload (a backend older than the field): say so plainly
    // rather than throwing or inventing one.
    await page.getByTestId("template-row-web-research-digest").click();
    await expect(page.getByTestId("template-complexity-note")).toContainText("no complexity band");

    // Zero capabilities stays its own stated fact, not an empty slot.
    await page.getByTestId("template-row-hello-agent").click();
    await expect(page.getByTestId("template-caps-none")).toContainText("no metered capabilities");
    await expect(page.getByTestId("template-complexity-note")).toContainText("Minimal 1/5");
  });

  test("preview: the handoff line tells the truth per kind (clone needs auth, starter is offline)", async ({
    page,
  }) => {
    await page.getByTestId("template-row-web-research-digest").click();
    await expect(page.getByTestId("template-handoff")).toContainText("Sapiom account");
    await page.getByTestId("template-row-coding-pause").click();
    await expect(page.getByTestId("template-handoff")).toContainText("No account, no network");
  });

  test("use (gallery): session at the destination + the real clone-tool prompt", async ({ page }) => {
    await page.getByTestId("template-row-web-research-digest").click();
    // Destination defaults to a new folder named after the template.
    await expect(page.getByTestId("template-dest-input")).toHaveValue(
      "/Users/demo/acme-app/web-research-digest",
    );
    await page.getByTestId("template-use-btn").click();

    // The welcome panel (and the dialog with it) yields to the new session.
    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);
    await expect(page.getByTestId("session-context-title")).toContainText("web-research-digest");

    // The injected prompt names the real operation and its arguments, and
    // ends with the run continuation: use → edit → run is one path.
    await expect
      .poll(async () => (await lastInject(page))?.req.text ?? "")
      .toContain("sapiom_dev_agents_clone");
    const record = await lastInject(page);
    expect(record?.req.text).toContain('templateId "web-research-digest"');
    expect(record?.req.text).toContain('dir "/Users/demo/acme-app/web-research-digest"');
    expect(record?.req.text).toContain("free local test run (sapiom_dev_agents_run_local)");
  });

  test("use (starter): the real bundled-template init command", async ({ page }) => {
    await page.getByTestId("template-row-coding-pause").click();
    await expect(page.getByTestId("template-dest-input")).toHaveValue("/Users/demo/acme-app/coding-pause");
    await page.getByTestId("template-use-btn").click();

    await expect(page.getByTestId("session-context-title")).toContainText("coding-pause");
    await expect
      .poll(async () => (await lastInject(page))?.req.text ?? "")
      .toContain("sapiom agents init . -t coding-pause");
    // The starter path carries the same run continuation as the clone path.
    expect((await lastInject(page))?.req.text).toContain("sapiom_dev_agents_run_local");
  });

  test("preview: the step graph renders in the canvas vocabulary before anything is cloned", async ({
    page,
  }) => {
    await page.getByTestId("template-row-web-research-digest").click();
    const graph = page.getByTestId("template-graph");
    await expect(graph).toBeVisible();

    // Entry and terminal carry their kind dots; the edge is the manifest's
    // real next pointer; the exit is marked.
    const search = graph.getByTestId("template-graph-node-search");
    await expect(search.locator(".canvas-step-dot.dot--entry")).toBeVisible();
    await expect(search).toContainText("web.search");
    await expect(search.locator(".canvas-step-transition-target")).toHaveText("summarize");
    const summarize = graph.getByTestId("template-graph-node-summarize");
    await expect(summarize.locator(".canvas-step-dot.dot--terminal-success")).toBeVisible();
    await expect(summarize).toContainText("exit");

    // A single-step template still previews honestly: one node, no edges. Its
    // step is the ENTRY — entry outranks terminal in classifyStepKind, same as
    // the canvas does for a one-step definition.
    await page.getByTestId("template-row-hello-agent").click();
    const greet = page.getByTestId("template-graph-node-greet");
    await expect(greet).toBeVisible();
    await expect(greet.locator(".canvas-step-dot.dot--entry")).toBeVisible();
    await expect(page.getByTestId("template-graph").locator(".canvas-step-transition")).toHaveCount(0);
  });

  test("preview: a fail-only exit is amber, and a pause step names its signal", async ({ page }) => {
    // The vocabulary the previous projection collapsed: every exit was a green
    // terminal-success and no step could be a pause.
    await page.getByTestId("template-row-dependency-upgrade").click();
    const giveUp = page.getByTestId("template-graph-node-give_up");
    await expect(giveUp.locator(".canvas-step-dot.dot--terminal-warn")).toBeVisible();
    await expect(giveUp).toContainText("fails out");

    await page.getByTestId("template-row-approval-chain").click();
    const decide = page.getByTestId("template-graph-node-decide");
    await expect(decide.locator(".canvas-step-dot.dot--pause")).toBeVisible();
    await expect(page.getByTestId("template-detail")).toContainText("pause · approval.decided");
  });

  test("a hand-edited destination survives switching templates", async ({ page }) => {
    const dest = page.getByTestId("template-dest-input");
    await dest.fill("/Users/demo/scratch/my-digest");
    await page.getByTestId("template-row-hello-agent").click();
    await expect(dest).toHaveValue("/Users/demo/scratch/my-digest");
  });

  test("Escape dismisses without creating anything", async ({ page }) => {
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("templates-dialog")).toHaveCount(0);
    await expect(page.getByTestId("welcome-panel")).toBeVisible();
    expect(await lastInject(page)).toBeUndefined();
  });
});

test("the add-project dialog hands off to templates (the 'I don't have a project yet' branch)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("add-workspace").click();
  await page.getByTestId("modal-browse-templates").click();
  // One dialog at a time: the add dialog yields to the templates browser.
  await expect(page.getByTestId("templates-dialog")).toBeVisible();
  await expect(page.locator(".modal-add-workspace")).toHaveCount(0);
});

test("the command palette's Browse templates action opens the gallery from anywhere", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("palette-trigger").click();

  // Unqueried, the action rides at the bottom under its own section — and
  // it is searchable like everything else.
  await expect(page.getByTestId("command-palette-section").filter({ hasText: "Actions" })).toHaveCount(1);
  await page.getByTestId("command-palette-input").fill("templates");
  await page.getByTestId("command-palette-list").getByText("Browse templates").click();

  await expect(page.getByTestId("templates-dialog")).toBeVisible();
  // The full journey is live from here too: gallery rows plus preview.
  await expect(page.getByTestId("template-row-web-research-digest")).toBeVisible();
  await expect(page.getByTestId("template-graph")).toBeVisible();
});
