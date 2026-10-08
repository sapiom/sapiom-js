/**
 * Moving between projects and sessions (plans/studio-navigation/flow-navigation.md
 * and design.md in the Sapiom repo; design-eng agent-studio-v2 NAVIGATION.md).
 *
 *  - The rail is Project › Sessions, the default and only view (4.1): every
 *    project a header, its sessions under it newest activity first, all
 *    expanded. No agents, no Group axis, no tab strip (Q2, Q3, Q8).
 *  - One click from any session to any other, in any project (4.2.3).
 *  - A project header puts its Agent Map in the centre at full width, no chat,
 *    and leaves the selected session alone (4.3).
 *  - A session, bound to an agent or not, has nothing beside it: no agent pane
 *    (flow-map-chat-overlay.md 4.4.1).
 *  - An agent on the map opens a panel in place: location with Change, its
 *    sessions, Start chat (4.4, Q7). Open canvas enters it in the same centre.
 *  - + on a project header is a new unbound chat at the root (4.5, Q11).
 *  - Cmd/Ctrl+1..9 is the Nth session of the selected project (Q2).
 *  - × ends a live session at once, no confirm, and hides an exited one
 *    (flow-map-chat-overlay.md 4.5).
 *
 * What these exist to prevent coming back: switching project to reach a
 * session (the complaint), the map squeezed beside a chat, a project click
 * that silently moves the session, and an accidental agent move.
 */
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

const activeSession = async (page: Page): Promise<string | null> =>
  page.getByTestId("session-context").getAttribute("data-session-id");

/** Every session row id under a project header, in rail order. */
const rowsOf = async (page: Page, project: string): Promise<string[]> =>
  page
    .getByTestId(`rail-project-${project}`)
    .locator(".rail-session-row")
    .evaluateAll((rows) =>
      rows.map((row) =>
        (row.getAttribute("data-testid") ?? "").replace("rail-session-", ""),
      ),
    );

/** Nothing beside the session: no agent pane and no control to open one. */
const expectNothingBeside = async (page: Page): Promise<void> => {
  await expect(page.locator(".right-pane")).toHaveCount(0);
  await expect(page.getByTestId("right-expand")).toHaveCount(0);
  const app = await page.locator(".app").boundingBox();
  const centre = await page.locator(".center-pane").boundingBox();
  expect(centre!.width).toBeGreaterThan(app!.width - 2);
};

test("the rail is Project › Sessions: sessions under each project, newest first, no agents and no tab strip", async ({
  page,
}) => {
  expect(await rowsOf(page, "acme-app")).toEqual([
    "sess-leasing-2",
    "sess-boot",
    "sess-leasing",
    "sess-phantom",
    "sess-pricing",
  ]);
  expect(await rowsOf(page, "rfq-agent")).toEqual(["sess-rfq"]);
  expect(await rowsOf(page, "scratch")).toEqual(["sess-bg"]);
  await expect(page.getByTestId("rail-project-acme-app")).toHaveAttribute(
    "data-session-count",
    "5",
  );
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
    "data-mark",
    "live",
  );
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
    "data-agent",
    "leasing",
  );
  await expect(page.getByTestId("rail-session-sess-leasing")).toHaveAttribute(
    "data-mark",
    "exited",
  );
  await expect(page.getByTestId("rail-session-time-sess-leasing")).toHaveText(
    "20m ago",
  );
  // A project with no sessions shows its header and + only (4.6.1).
  expect(await rowsOf(page, "onboarding-flow")).toEqual([]);
  await expect(page.getByTestId("project-new-chat-onboarding-flow")).toBeVisible();
  // No agents, no tab strip, no Group axis (Q2, Q3, Q8).
  await expect(page.locator(".rail-workflows [data-testid^='workflow-']")).toHaveCount(0);
  await expect(page.locator(".session-tabs")).toHaveCount(0);
  await page.getByTestId("history-trigger").click();
  await expect(page.getByTestId("filing-group-by")).toHaveCount(0);
  await expect(page.getByTestId("sort-recent")).toBeVisible();
  await expect(page.getByTestId("sort-name")).toBeVisible();
});

test("one click moves between sessions in different projects, and the rail does not change", async ({
  page,
}) => {
  await expect.poll(() => activeSession(page)).toBe("sess-boot");
  const before = {
    acme: await rowsOf(page, "acme-app"),
    scratch: await rowsOf(page, "scratch"),
  };

  // acme-app → scratch: one click.
  await page.getByTestId("rail-session-select-sess-bg").click();
  await expect.poll(() => activeSession(page)).toBe("sess-bg");
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect(page.getByTestId("rail-session-sess-bg")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("rail-session-sess-boot")).not.toHaveAttribute("data-selected", "true");
  // The project separation stays clear: the selected session's project header
  // wears the quieter highlight, and only that one.
  await expect(page.getByTestId("workspace-group-scratch")).toHaveAttribute("data-holds-selection", "true");
  await expect(page.getByTestId("workspace-group-acme-app")).not.toHaveAttribute("data-holds-selection", "true");

  // ...and straight back: one click again, no project click in between.
  await page.getByTestId("rail-session-select-sess-boot").click();
  await expect.poll(() => activeSession(page)).toBe("sess-boot");
  await expect(page.getByTestId("workspace-group-acme-app")).toHaveAttribute("data-holds-selection", "true");

  expect(await rowsOf(page, "acme-app")).toEqual(before.acme);
  expect(await rowsOf(page, "scratch")).toEqual(before.scratch);
});

test("a project header puts its map in the centre at full width with no chat, and leaves the session selected", async ({
  page,
}) => {
  await expect.poll(() => activeSession(page)).toBe("sess-boot");

  await page.getByTestId("project-select-acme-app").click();
  const pane = page.getByTestId("project-map-pane");
  await expect(pane).toBeVisible();
  await expect(pane).toHaveAttribute("data-view", "map");
  await expect(page.getByTestId("session-context-title")).toHaveText("acme-app");
  await expect(page.getByTestId("session-project-map-chip")).toHaveText("Agent Map");
  await expect(page.getByTestId("project-map-new-agent")).toBeVisible();
  // No chat beside it.
  await expect(page.getByTestId("agent-view")).toHaveCount(0);
  // Full width: the map spans the centre.
  const app = await page.locator(".app").boundingBox();
  const map = await pane.boundingBox();
  expect(map!.width).toBeGreaterThan(app!.width - 40);
  // The session is untouched: still selected, still in the rail.
  await expect(page.getByTestId("workspace-group-acme-app")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute("data-selected", "true");

  // One click brings the session back.
  await page.getByTestId("rail-session-select-sess-boot").click();
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
});

test("a session has nothing beside it, bound to an agent or not, live or ended", async ({
  page,
}) => {
  // sess-boot is bound to leasing: its agent's detail is the project view's.
  await expect.poll(() => activeSession(page)).toBe("sess-boot");
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute("data-agent", "leasing");
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expectNothingBeside(page);

  await page.getByTestId("rail-session-select-sess-bg").click();
  await expect.poll(() => activeSession(page)).toBe("sess-bg");
  await expectNothingBeside(page);

  await page.getByTestId("rail-session-select-sess-boot").click();
  await page.getByTestId("session-menu").click();
  await page.getByTestId("session-end-btn").click();
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  await expectNothingBeside(page);
});

test("clicking an agent on the map names it on the card, with its path, and no Sessions list or Start chat", async ({
  page,
}) => {
  await page.getByTestId("project-select-acme-app").click();
  const before = await rowsOf(page, "acme-app");
  await page.getByTestId("map-agent-leasing").click();
  const card = page.getByTestId("map-card");
  await expect(card).toHaveAttribute("data-subject", "leasing");
  await expect(page.getByTestId("map-card-name")).toHaveAttribute(
    "data-tooltip",
    "/Users/demo/acme-app/leasing",
  );
  // Sessions are the rail's; the card neither lists nor starts one (4.2.2).
  await expect(card).not.toContainText("Sessions");
  await expect(page.getByTestId("map-agent-start-chat")).toHaveCount(0);
  expect(await rowsOf(page, "acme-app")).toEqual(before);
});

test("Open agent opens the agent's modal over the map without moving the session; closing returns to the map", async ({
  page,
}) => {
  await page.getByTestId("rail-session-select-sess-bg").click();
  await expect.poll(() => activeSession(page)).toBe("sess-bg");
  await page.getByTestId("project-select-acme-app").click();
  await page.getByTestId("map-agent-leasing").click();
  await page.getByTestId("map-card-open-agent").click();
  await expect(page.getByTestId("agent-modal")).toHaveAttribute("data-agent", "leasing");
  // The map stays the centre underneath; no entered page, no session view.
  await expect(page.getByTestId("project-map-pane")).toHaveAttribute("data-view", "map");
  await expect(page.getByTestId("agent-view")).toHaveCount(0);
  await expect(page.getByTestId("rail-session-sess-bg")).toHaveAttribute("data-selected", "true");

  await page.getByTestId("agent-modal-close").click();
  await expect(page.getByTestId("agent-modal")).toHaveCount(0);
  await expect(page.getByTestId("map-card")).toHaveAttribute("data-subject", "leasing");
  await expect(page.getByTestId("rail-session-sess-bg")).toHaveAttribute("data-selected", "true");
});

test("+ on a project header starts an unbound chat at the root, selected, with nothing beside it", async ({
  page,
}) => {
  const before = await rowsOf(page, "rfq-agent");
  await page.getByTestId("project-new-chat-rfq-agent").click();
  await expect.poll(() => rowsOf(page, "rfq-agent")).toHaveLength(before.length + 1);
  await expect(page.getByTestId("agent-view")).toBeVisible();
  const after = await rowsOf(page, "rfq-agent");
  const created = after[0]!;
  await expect.poll(() => activeSession(page)).toBe(created);
  await expect(page.getByTestId(`rail-session-${created}`)).not.toHaveAttribute("data-agent", /.+/);
  await expect(page.getByTestId(`rail-session-${created}`)).toHaveAttribute("data-mark", "live");
  await expectNothingBeside(page);
});

test("Cmd/Ctrl+1..9 selects the Nth session of the selected project in rail order", async ({
  page,
}) => {
  await expect.poll(() => activeSession(page)).toBe("sess-boot");
  // The selected session's project: acme-app.
  await page.keyboard.press("Meta+3");
  await expect.poll(() => activeSession(page)).toBe("sess-leasing");
  await page.keyboard.press("Meta+1");
  await expect.poll(() => activeSession(page)).toBe("sess-leasing-2");
  // The project whose map is showing wins over the session's project.
  await page.getByTestId("project-select-rfq-agent").click();
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
  await page.keyboard.press("Meta+1");
  await expect.poll(() => activeSession(page)).toBe("sess-rfq");
  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
  // Beyond the project's rows does nothing.
  await page.keyboard.press("Meta+5");
  await expect.poll(() => activeSession(page)).toBe("sess-rfq");
});

test("× on a live row ends it at once, no confirm, and it stays selected as exited; × on an exited row hides it and History keeps it", async ({
  page,
}) => {
  await page.getByTestId("rail-session-select-sess-leasing-2").click();
  await expect.poll(() => activeSession(page)).toBe("sess-leasing-2");

  await page.getByTestId("rail-session-sess-leasing-2").hover();
  await page.getByTestId("rail-session-close-sess-leasing-2").click();
  // One press ends it: no dialog stands between the × and the process.
  await expect(page.getByTestId("rail-session-sess-leasing-2")).toHaveAttribute("data-mark", "exited");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByTestId("end-session-confirm")).toHaveCount(0);
  // Ending never jumps the centre to another session (D43).
  await expect.poll(() => activeSession(page)).toBe("sess-leasing-2");
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();

  await page.getByTestId("rail-session-sess-leasing-2").hover();
  await page.getByTestId("rail-session-close-sess-leasing-2").click();
  await expect(page.getByTestId("rail-session-sess-leasing-2")).toHaveCount(0);
  // The selected session was hidden, so the centre moved to its project.
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
  await expect(page.getByTestId("workspace-group-acme-app")).toHaveAttribute("data-selected", "true");

  await page.getByTestId("rail-history").click();
  await expect(page.getByTestId("exited-session-sess-leasing-2")).toBeVisible();
});

test("a hidden session stays hidden across a reload, and History still lists it", async ({
  page,
}) => {
  await page.getByTestId("rail-session-sess-leasing").hover();
  await page.getByTestId("rail-session-close-sess-leasing").click();
  await expect(page.getByTestId("rail-session-sess-leasing")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("rail-session-sess-phantom")).toBeVisible();
  await expect(page.getByTestId("rail-session-sess-leasing")).toHaveCount(0);
  await page.getByTestId("rail-history").click();
  await expect(page.getByTestId("exited-session-sess-leasing")).toBeVisible();
});

test("a project with no agents opens the new-agent screen from its header (D36)", async ({
  page,
}) => {
  await page.getByTestId("project-select-scratch").click();
  await expect(page.getByTestId("session-project-chip")).toContainText("scratch");
  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
});

test("a project whose only agent has no sapiom.json opens its map, not the new-agent screen", async ({
  page,
}) => {
  await page.goto("/?seed=0&mockStudioProjects=present&mockProjectMapUnlisted=1");
  await page.getByTestId("project-select-scratch").click();
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
  await expect(page.getByTestId("project-map-pane")).toContainText("1 agent");
});

test("a drawn map's header has New agent and no full-view button", async ({
  page,
}) => {
  await page.goto("/?seed=0&mockStudioProjects=present");
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  await expect(page.getByTestId("project-map-new-agent")).toBeVisible();
  await expect(page.getByTestId("canvas-expand")).toHaveCount(0);
});

test("a session row's × is reachable by keyboard, and agent cards keep their button role", async ({
  page,
}) => {
  await page.getByTestId("rail-session-select-sess-leasing").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("rail-session-close-sess-leasing")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("rail-session-sess-leasing")).toHaveCount(0);

  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByRole("button", { name: /leasing/ }).and(page.getByTestId("map-agent-leasing"))).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByTestId("project-agent-grid").getByRole("listitem")).toHaveCount(1);
});
