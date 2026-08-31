/**
 * Templates journey (browse → read → use), all in mock mode.
 *
 * Ground truth this exercises: the catalog is FETCHED (GET /api/templates, which
 * the server relays from core) rather than pinned in lib/templates.ts, only the
 * bundled starters are local, the detail view renders only real manifest fields,
 * and "Use template" performs the REAL handoff shape — a session at the
 * destination folder plus the agent prompt naming sapiom_dev_agents_clone
 * (gallery) or `sapiom_dev_agents_scaffold` (bundled starter). MockApi records the
 * injection on window.__HARNESS_TEST__.lastInjectInput.
 *
 * Browsing is a DESTINATION now, not a dialog, and that changes the shape of
 * these tests in three ways worth knowing before editing them:
 *
 *  - a template is opened from its card (`template-card-open-<id>`) and closed
 *    with the bar's back button, so reading two in a row means going back
 *    between them — see `open()`;
 *  - the destination is a view and cannot be dismissed with Escape. Escape
 *    belongs to the use-confirm dialog, which is where a commit is now asked
 *    for;
 *  - the destination folder is asked once, in that dialog, by the same
 *    FolderField the session and workspace flows use (`folder-field-input`).
 *    It is therefore no longer a persistent field that can be hand-edited and
 *    carried across template switches — that behaviour is gone deliberately.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

interface InjectRecord {
  id: string;
  req: { text: string; submit?: boolean };
}

const lastInject = (page: Page): Promise<InjectRecord | undefined> =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { lastInjectInput?: unknown };
        }
      ).__HARNESS_TEST__?.lastInjectInput as InjectRecord | undefined,
  );

/** Open a template's full view from the grid, returning to the grid first when
 *  another template is already open. */
async function open(page: Page, id: string): Promise<void> {
  const back = page.getByTestId("template-detail-back");
  if (await back.count()) await back.click();
  await page.getByTestId(`template-card-open-${id}`).click();
  await expect(page.getByTestId("template-detail")).toBeVisible();
}

test.describe("templates journey (from the composer)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mockState=fresh");
    // A fresh install opens on the composer-first "new session" home; its
    // "Browse all templates" is the way into the catalog destination.
    await expect(page.getByTestId("new-session-composer")).toBeVisible();
    await page.getByTestId("composer-browse-templates").click();
    await expect(page.getByTestId("templates-panel")).toBeVisible();
    // The grid renders from the fetch; waiting on it keeps every test below
    // from racing the catalog.
    await expect(page.getByTestId("templates-grid").first()).toBeVisible();
  });

  test("browse: catalog cards plus the two bundled starters", async ({
    page,
  }) => {
    await expect(page.locator(".templates-hero-copy")).toContainText(
      "runnable agents",
    );
    await expect(page.locator(".templates-hero-copy")).not.toContainText(
      "workflows",
    );
    // Real clonable slugs from the catalog, not a hardcoded pair.
    await expect(
      page.getByTestId("template-card-web-research-digest"),
    ).toBeVisible();
    await expect(page.getByTestId("template-card-hello-agent")).toBeVisible();
    // Starters keep their own block: a different kind of thing, and the floor
    // when the gallery is unreachable.
    const starters = page.getByTestId("templates-starters");
    await expect(starters.getByTestId("template-card-default")).toBeVisible();
    await expect(
      starters.getByTestId("template-card-coding-pause"),
    ).toBeVisible();

    await page.screenshot({
      path: "web/e2e/screenshots/templates-panel.png",
      fullPage: true,
    });
  });

  test("browse: the facet axes are the registry's own, counted over the whole catalog", async ({
    page,
  }) => {
    // Category is the outcome axis; Trigger is `cadence`. Both are derived from
    // what the fetch returned — never a bundled copy of the taxonomy.
    const all = page.getByTestId("templates-category-all");
    await expect(all).toContainText("All templates");
    await expect(page.getByTestId("templates-cadence-all")).toContainText(
      "Any trigger",
    );

    // Picking a trigger narrows the grid to the cards that declare it.
    await page.getByTestId("templates-cadence-scheduled").click();
    await expect(
      page.getByTestId("template-card-dependency-upgrade"),
    ).toBeVisible();
    await expect(page.getByTestId("template-card-hello-agent")).toHaveCount(0);
    // Starters declare no cadence, so a trigger selection is a statement about
    // the gallery and must not leave them on screen as if they matched.
    await expect(page.getByTestId("templates-starters")).toHaveCount(0);

    // The "everything" row is the way back — no separate clear-filters bar.
    await page.getByTestId("templates-cadence-all").click();
    await expect(page.getByTestId("template-card-hello-agent")).toBeVisible();
  });

  test("browse: search matches tags, not just names, and offers a reset when it matches nothing", async ({
    page,
  }) => {
    // Tags are not a facet list precisely because search covers them.
    await page.getByTestId("template-search").fill("research");
    await expect(
      page.getByTestId("template-card-web-research-digest"),
    ).toBeVisible();
    await expect(page.getByTestId("template-card-hello-agent")).toHaveCount(0);

    await page.getByTestId("template-search").fill("no-such-template");
    await expect(page.getByTestId("templates-empty")).toBeVisible();
    await page.getByTestId("templates-empty-clear").click();
    await expect(page.getByTestId("template-card-hello-agent")).toBeVisible();
  });

  test("browse: the card's spec sheet reports the catalog's own figures", async ({
    page,
  }) => {
    // Steps/cost/trigger are reference figures, not what you choose by, so they
    // live one press away rather than on the face of every card.
    await page.getByTestId("template-card-info-dependency-upgrade").click();
    const facts = page.getByTestId("template-facts");
    await expect(facts).toContainText("Steps");
    await expect(facts).toContainText("Advanced 5/5");
    // The band replaced a price, so nothing on the sheet may read as money.
    expect(await facts.textContent()).not.toMatch(/\$/);

    // A response carrying no band shows an em dash rather than inventing one.
    await page.keyboard.press("Escape");
    await page.getByTestId("template-card-info-web-research-digest").click();
    await expect(page.getByTestId("template-facts")).toContainText("—");
  });

  test("read: real registry metadata — ordered steps, capability, tags, author", async ({
    page,
  }) => {
    await open(page, "web-research-digest");
    const detail = page.getByTestId("template-detail");
    await expect(detail).toContainText("Web Research Digest");
    await expect(detail).toContainText("By");
    await expect(detail).toContainText("Sapiom");

    // Steps render in declared order, each labelled with the role the SHARED
    // classifier assigned (classifyStepKind) rather than a terminal-or-not guess.
    const stepNames = detail.locator(".template-step-name");
    await expect(stepNames.nth(0)).toContainText("search");
    await expect(stepNames.nth(0)).toContainText("entry");
    await expect(stepNames.nth(1)).toContainText("summarize");
    await expect(stepNames.nth(1)).toContainText("terminal · success");
    await expect(detail.locator(".template-cap").first()).toContainText(
      "web.search",
    );
  });

  test("read: the band core served, explained by what produced it — and never a price", async ({
    page,
  }) => {
    // Replaced a per-run cost estimate core no longer computes (SAP-2085). The
    // band is shown with the counts behind it, so it reads as an estimate of
    // shape rather than an opaque verdict.
    await open(page, "dependency-upgrade");
    const note = page.getByTestId("template-complexity-note");
    await expect(note).toContainText("Advanced 5/5");
    await expect(note).toContainText("2 model steps, 1 chained");
    // Nothing on this surface may read as money any more.
    expect(await note.textContent()).not.toMatch(/\$/);

    // A deterministic saga: the largest graph in the catalog, and still Simple.
    // The scorer weighs judgment, not topology — the point of the band.
    await open(page, "approval-chain");
    await expect(page.getByTestId("template-complexity-note")).toContainText(
      "Simple 2/5",
    );
    await expect(page.getByTestId("template-complexity-note")).toContainText(
      "deterministic",
    );

    // No band in the payload (a backend older than the field): say so plainly
    // rather than throwing or inventing one.
    await open(page, "web-research-digest");
    await expect(page.getByTestId("template-complexity-note")).toContainText(
      "no complexity band",
    );

    // Zero capabilities stays its own stated fact, not an empty slot.
    await open(page, "hello-agent");
    await expect(page.getByTestId("template-caps-none")).toContainText(
      "no metered capabilities",
    );
    await expect(page.getByTestId("template-complexity-note")).toContainText(
      "Minimal 1/5",
    );
  });

  test("read: the handoff line tells the truth per kind (clone needs auth, starter may use npm)", async ({
    page,
  }) => {
    await open(page, "web-research-digest");
    await expect(page.getByTestId("template-handoff")).toHaveText(
      "Using it forks the template into a repo you own, then clones it here. Needs a signed-in Sapiom account; the coding agent asks you to sign in if it is missing.",
    );
    await open(page, "coding-pause");
    await expect(page.getByTestId("template-handoff")).toContainText(
      "No Sapiom account or capability spend; setup may access npm",
    );
  });

  test("use (gallery): session at the destination + the real clone-tool prompt", async ({
    page,
  }) => {
    await open(page, "web-research-digest");
    await page.getByTestId("template-use-btn").click();

    // The destination is asked once, and defaults to a new folder named after
    // the template under the resolved project root.
    await expect(page.getByTestId("folder-field-input")).toHaveValue(
      "/Users/demo/acme-app/projects/web-research-digest",
    );
    await page.getByTestId("template-use-confirm").click();

    // The browser yields to the session it just started — leaving it mounted
    // would bury the thing you asked for.
    await expect(page.getByTestId("templates-panel")).toHaveCount(0);
    await expect(page.getByTestId("session-context-title")).toContainText(
      "web-research-digest",
    );

    // The workspace folder joins the rail from the instant the clone starts (a
    // "creating agent" placeholder first), so switching away mid-clone can never
    // lose the in-progress agent — on a fresh install this is the very first row.
    await expect(
      page.getByTestId("workspace-group-web-research-digest"),
    ).toBeVisible();

    // The injected prompt names the real operation and its arguments, and ends
    // with the run continuation: use → edit → run is one path.
    await expect
      .poll(async () => (await lastInject(page))?.req.text ?? "")
      .toContain("sapiom_dev_agents_clone");
    const record = await lastInject(page);
    expect(record?.req.text).toContain('templateId "web-research-digest"');
    expect(record?.req.text).toContain(
      'dir "/Users/demo/acme-app/projects/web-research-digest"',
    );
    expect(record?.req.text).toContain(
      "local test run with no Sapiom capability spend (sapiom_dev_agents_run_local)",
    );
  });

  test("use (starter): the HARNESS scaffolds it, no prompt", async ({ page }) => {
    // SAP-2981, E4.6. A bundled starter is the same local scaffold the project
    // `+` does, so it goes through the same endpoint: two creation paths for
    // one operation is how they drift. The clone path above still hands the
    // work to the coding agent, because forking a published template over the
    // network is a different operation with a different failure mode.
    await open(page, "coding-pause");
    await page.getByTestId("template-use-btn").click();
    await expect(page.getByTestId("folder-field-input")).toHaveValue(
      "/Users/demo/acme-app/projects/coding-pause",
    );
    await page.getByTestId("template-use-confirm").click();

    // Created first, THEN talked to — the same order the create dialog keeps.
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            ((window as unknown as { __HARNESS_TEST__?: { createOrder?: string[] } })
              .__HARNESS_TEST__?.createOrder ?? []) as string[],
        ),
      )
      .toEqual([
        "scaffold:/Users/demo/acme-app/projects/coding-pause",
        "session:/Users/demo/acme-app/projects",
      ]);
    await expect(page.getByTestId("workflow-coding-pause")).toBeVisible();
    // And nobody was asked, in English, to perform a filesystem operation.
    expect((await lastInject(page))?.req.text ?? "").not.toContain(
      "sapiom_dev_agents_scaffold",
    );
  });

  test("use: straight from a card's spec sheet, skipping the read", async ({
    page,
  }) => {
    // Someone who already knows the template shouldn't have to open it first.
    await page.getByTestId("template-card-info-hello-agent").click();
    await page.getByTestId("template-facts-use-hello-agent").click();
    await expect(page.getByTestId("template-use-dialog")).toBeVisible();
    await expect(page.getByTestId("folder-field-input")).toHaveValue(
      "/Users/demo/acme-app/projects/hello-agent",
    );
  });

  test("read: the step graph renders in the canvas vocabulary before anything is cloned", async ({
    page,
  }) => {
    await open(page, "web-research-digest");
    const graph = page.getByTestId("template-graph");
    await expect(graph).toBeVisible();

    // Entry and terminal carry their kind dots; the edge is the manifest's real
    // next pointer; the exit is marked.
    const search = graph.getByTestId("template-graph-node-search");
    await expect(search.locator(".canvas-step-dot.dot--entry")).toBeVisible();
    await expect(search).toContainText("web.search");
    await expect(search.locator(".canvas-step-transition-target")).toHaveText(
      "summarize",
    );
    const summarize = graph.getByTestId("template-graph-node-summarize");
    await expect(
      summarize.locator(".canvas-step-dot.dot--terminal-success"),
    ).toBeVisible();
    await expect(summarize).toContainText("exit");

    // A single-step template still previews honestly: one node, no edges. Its
    // step is the ENTRY — entry outranks terminal in classifyStepKind, same as
    // the canvas does for a one-step definition.
    await open(page, "hello-agent");
    const greet = page.getByTestId("template-graph-node-greet");
    await expect(greet).toBeVisible();
    await expect(greet.locator(".canvas-step-dot.dot--entry")).toBeVisible();
    await expect(
      page.getByTestId("template-graph").locator(".canvas-step-transition"),
    ).toHaveCount(0);
  });

  test("read: a fail-only exit is amber, and a pause step names its signal", async ({
    page,
  }) => {
    // The vocabulary the previous projection collapsed: every exit was a green
    // terminal-success and no step could be a pause.
    await open(page, "dependency-upgrade");
    const giveUp = page.getByTestId("template-graph-node-give_up");
    await expect(
      giveUp.locator(".canvas-step-dot.dot--terminal-warn"),
    ).toBeVisible();
    await expect(giveUp).toContainText("fails out");

    await open(page, "approval-chain");
    const decide = page.getByTestId("template-graph-node-decide");
    await expect(decide.locator(".canvas-step-dot.dot--pause")).toBeVisible();
    await expect(page.getByTestId("template-detail")).toContainText(
      "pause · approval.decided",
    );
  });

  test("leaving: back returns to the grid, then to where you came from, creating nothing", async ({
    page,
  }) => {
    await open(page, "hello-agent");
    await page.getByTestId("template-detail-back").click();
    await expect(page.getByTestId("templates-grid").first()).toBeVisible();

    await page.getByTestId("templates-exit").click();
    await expect(page.getByTestId("templates-panel")).toHaveCount(0);
    // Back to the shell, NOT to the Overview card that launched this: choosing
    // "Browse templates" dismissed it, because that click was a navigation away.
    await expect(page.locator(".center-pane")).toBeVisible();
    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);
    expect(await lastInject(page)).toBeUndefined();
  });

  test("Escape abandons the commit, not the browsing", async ({ page }) => {
    // Escape belongs to the dialog that asks the one question. The destination
    // itself is a view: it is left with the back button, not dismissed.
    await open(page, "hello-agent");
    await page.getByTestId("template-use-btn").click();
    await expect(page.getByTestId("template-use-dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("template-use-dialog")).toHaveCount(0);
    await expect(page.getByTestId("templates-panel")).toBeVisible();
    expect(await lastInject(page)).toBeUndefined();
  });
});

test("the rail navigates to templates, and says so while you are there", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();

  const nav = page.getByTestId("rail-templates");
  await expect(nav).not.toHaveClass(/is-selected/);
  await nav.click();

  await expect(page.getByTestId("templates-panel")).toBeVisible();
  await expect(nav).toHaveClass(/is-selected/);
  // The destination stands in for the workbench rather than sitting inside it.
  await expect(page.locator(".center-pane")).toBeHidden();
});

test("the rail navigates away from templates: another nav row dismisses the browser", async ({
  page,
}) => {
  // The browsing destination hid the workbench and used to swallow the rail's
  // other nav rows — the only way out was the back arrow. Any real navigation
  // (here, Create new) must leave templates the same way the back arrow does.
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();

  await page.getByTestId("rail-templates").click();
  await expect(page.getByTestId("templates-panel")).toBeVisible();
  await expect(page.locator(".center-pane")).toBeHidden();

  await page.getByTestId("rail-create-new").click();

  // The template destination is gone and the workbench is back — you actually
  // navigated, rather than staying stranded on the browser.
  await expect(page.getByTestId("templates-panel")).toHaveCount(0);
  await expect(page.getByTestId("rail-templates")).not.toHaveClass(/is-selected/);
  await expect(page.locator(".center-pane")).toBeVisible();
});

test("the command palette's Browse templates action opens the browser from anywhere", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("palette-trigger").click();

  // Unqueried, the action rides at the bottom under its own section — and it is
  // searchable like everything else.
  await expect(
    page.getByTestId("command-palette-section").filter({ hasText: "Actions" }),
  ).toHaveCount(1);
  await page.getByTestId("command-palette-input").fill("templates");
  await page
    .getByTestId("command-palette-list")
    .getByText("Browse templates")
    .click();

  await expect(page.getByTestId("templates-panel")).toBeVisible();
  await expect(
    page.getByTestId("template-card-web-research-digest"),
  ).toBeVisible();
});
