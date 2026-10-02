/**
 * Moving between projects and sessions (plans/studio-navigation/flow-navigation.md
 * and design.md in the Sapiom repo; design-eng agent-studio-v2 NAVIGATION.md).
 *
 *  - The rail is Project › Sessions, the default and only view (4.1): every
 *    project a header, its sessions under it newest activity first, all
 *    expanded. No agents, no Group axis, no tab strip (Q2, Q3, Q8).
 *  - One click from any session to any other, in any project (4.2.3).
 *  - A project header puts its Agent Map in the centre at full width, no chat,
 *    no right pane, and leaves the selected session alone (4.3).
 *  - An agent on the map opens a panel in place: location with Change, its
 *    sessions, Start chat (4.4, Q7). Open canvas enters it in the same centre.
 *  - + on a project header is a new unbound chat at the root (4.5, Q11).
 *  - Cmd/Ctrl+1..9 is the Nth session of the selected project (Q2).
 *  - × ends a live session (behind the confirm) and hides an exited one (Q4).
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

/** The right pane is ON SCREEN: a bound session's agent, not closed. */
const rightPaneShown = (page: Page) =>
  page.locator(".right-pane:not(.is-collapsed):not([data-absent])");

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

test("a project header puts its map in the centre at full width with no chat and no right pane, and leaves the session selected", async ({
  page,
}) => {
  await expect.poll(() => activeSession(page)).toBe("sess-boot");
  await expect(rightPaneShown(page)).toBeVisible();

  await page.getByTestId("project-select-acme-app").click();
  const pane = page.getByTestId("project-map-pane");
  await expect(pane).toBeVisible();
  await expect(pane).toHaveAttribute("data-view", "map");
  await expect(page.getByTestId("session-context-title")).toHaveText("acme-app");
  await expect(page.getByTestId("session-project-map-chip")).toHaveText("Agent Map");
  await expect(page.getByTestId("project-map-new-agent")).toBeVisible();
  // No chat beside it, and no right pane at all.
  await expect(page.getByTestId("agent-view")).toHaveCount(0);
  await expect(page.locator(".right-pane")).toHaveAttribute("data-absent", "true");
  await expect(page.getByTestId("right-expand")).toHaveCount(0);
  // Full width: the map spans the centre the session and its pane shared.
  const app = await page.locator(".app").boundingBox();
  const map = await pane.boundingBox();
  expect(map!.width).toBeGreaterThan(app!.width - 40);
  // The session is untouched: still selected, still in the rail.
  await expect(page.getByTestId("workspace-group-acme-app")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute("data-selected", "true");

  // One click brings the session back, chat and pane together.
  await page.getByTestId("rail-session-select-sess-boot").click();
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect(rightPaneShown(page)).toBeVisible();
  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
});

test("the right pane is the session's bound agent, absent when unbound, and its closed state is the user's", async ({
  page,
}) => {
  await expect.poll(() => activeSession(page)).toBe("sess-boot");
  await expect(rightPaneShown(page)).toBeVisible();
  await page.getByTestId("right-collapse").click();
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);

  // An unbound session has no pane at all: no reopen control either.
  await page.getByTestId("rail-session-select-sess-bg").click();
  await expect.poll(() => activeSession(page)).toBe("sess-bg");
  await expect(page.locator(".right-pane")).toHaveAttribute("data-absent", "true");
  await expect(page.getByTestId("right-expand")).toHaveCount(0);

  // Back on the bound session the user's choice held: still closed.
  await page.getByTestId("rail-session-select-sess-boot").click();
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);
  await expect(page.locator(".right-pane")).not.toHaveAttribute("data-absent", "true");
  await page.getByTestId("right-expand").click();
  await expect(rightPaneShown(page)).toBeVisible();

  // And open survives the same round trip.
  await page.getByTestId("rail-session-select-sess-bg").click();
  await page.getByTestId("rail-session-select-sess-boot").click();
  await expect(rightPaneShown(page)).toBeVisible();
});

test("clicking an agent on the map opens its panel; Start chat makes a bound session at the top of the project and selects it", async ({
  page,
}) => {
  await page.getByTestId("project-select-acme-app").click();
  await page.getByTestId("map-agent-leasing").click();
  const panel = page.getByTestId("map-agent-panel");
  await expect(panel).toHaveAttribute("data-agent", "leasing");
  await expect(page.getByTestId("map-agent-panel-path")).toHaveText("/Users/demo/acme-app/leasing");
  // Its sessions: the two bound to it, in rail order.
  await expect(page.getByTestId("map-agent-session-sess-leasing-2")).toBeVisible();
  await expect(page.getByTestId("map-agent-session-sess-boot")).toBeVisible();

  const before = await rowsOf(page, "acme-app");
  await page.getByTestId("map-agent-start-chat").click();
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect.poll(() => rowsOf(page, "acme-app")).toHaveLength(before.length + 1);
  const after = await rowsOf(page, "acme-app");
  const created = after[0]!;
  expect(before).not.toContain(created);
  await expect.poll(() => activeSession(page)).toBe(created);
  // Bound to the agent, so the right pane is that agent's.
  await expect(page.getByTestId(`rail-session-${created}`)).toHaveAttribute("data-agent", "leasing");
  await expect(rightPaneShown(page)).toBeVisible();
});

test("a session in the agent panel opens that session; Open canvas enters the agent and back returns to the map", async ({
  page,
}) => {
  await page.getByTestId("rail-session-select-sess-bg").click();
  await expect.poll(() => activeSession(page)).toBe("sess-bg");
  await page.getByTestId("project-select-acme-app").click();
  await page.getByTestId("map-agent-leasing").click();
  await page.getByTestId("map-agent-open-canvas").click();
  await expect(page.getByTestId("project-map-pane")).toHaveAttribute("data-view", "agent");
  await expect(page.getByTestId("session-map-agent-chip")).toHaveText("leasing");
  await expect(page.getByTestId("agent-view")).toHaveCount(0);
  // Entering an agent is still the project view: the session did not move.
  await expect(page.getByTestId("rail-session-sess-bg")).toHaveAttribute("data-selected", "true");

  await page.getByTestId("project-map-back").click();
  await expect(page.getByTestId("project-map-pane")).toHaveAttribute("data-view", "map");

  await page.getByTestId("map-agent-leasing").click();
  await page.getByTestId("map-agent-session-sess-leasing-2").click();
  await expect.poll(() => activeSession(page)).toBe("sess-leasing-2");
  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
});

test("+ on a project header starts an unbound chat at the root, selected, with no right pane", async ({
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
  await expect(page.locator(".right-pane")).toHaveAttribute("data-absent", "true");
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

test("× on a live row ends it behind the confirm and it stays selected as exited; × on an exited row hides it and History keeps it", async ({
  page,
}) => {
  await page.getByTestId("rail-session-select-sess-leasing-2").click();
  await expect.poll(() => activeSession(page)).toBe("sess-leasing-2");

  await page.getByTestId("rail-session-sess-leasing-2").hover();
  await page.getByTestId("rail-session-close-sess-leasing-2").click();
  await expect(page.getByTestId("end-session-confirm")).toBeVisible();
  await page.getByTestId("end-session-confirm-btn").click();
  await expect(page.getByTestId("rail-session-sess-leasing-2")).toHaveAttribute("data-mark", "exited");
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

test("Change location confirms with both paths, then moves the agent and its sessions follow", async ({
  page,
}) => {
  await page.getByTestId("project-select-acme-app").click();
  await page.getByTestId("map-agent-leasing").click();
  await page.getByTestId("map-agent-change-location").click();
  const field = page.getByTestId("map-agent-location-input");

  // A destination inside the agent is refused under the field.
  await field.fill("/Users/demo/acme-app/leasing/nested");
  await expect(page.getByTestId("map-agent-location-error")).toContainText("inside itself");
  await expect(page.getByTestId("map-agent-location-submit")).toBeDisabled();
  await field.fill("relative/path");
  await expect(page.getByTestId("map-agent-location-error")).toHaveText("Use an absolute path.");
  // The move route keeps the folder name and lands inside an open project.
  await field.fill("/Users/demo/acme-app/leasing-v2");
  await expect(page.getByTestId("map-agent-location-error")).toContainText("Keep the folder name leasing");
  await field.fill("/Users/demo/elsewhere/leasing");
  await expect(page.getByTestId("map-agent-location-error")).toContainText("open projects");

  await field.fill("/Users/demo/acme-app/agents/leasing");
  await page.getByTestId("map-agent-location-submit").click();
  const confirm = page.getByTestId("change-location-confirm");
  await expect(confirm).toBeVisible();
  await expect(page.getByTestId("change-location-old")).toHaveText("/Users/demo/acme-app/leasing");
  await expect(page.getByTestId("change-location-new")).toHaveText("/Users/demo/acme-app/agents/leasing");
  // Keep it here moves nothing.
  await page.getByTestId("change-location-cancel").click();
  await expect(confirm).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __HARNESS_TEST__?: { agentMoves?: unknown[] } }).__HARNESS_TEST__?.agentMoves ?? [],
    ),
  ).toEqual([]);

  await page.getByTestId("map-agent-location-submit").click();
  await page.getByTestId("change-location-confirm-move").click();
  await expect(page.getByTestId("map-agent-panel-path")).toHaveText("/Users/demo/acme-app/agents/leasing");
  expect(
    await page.evaluate(
      () => (window as unknown as { __HARNESS_TEST__?: { agentMoves?: unknown[] } }).__HARNESS_TEST__?.agentMoves ?? [],
    ),
  ).toEqual([{ from: "/Users/demo/acme-app/leasing", to: "/Users/demo/acme-app/agents/leasing" }]);
  // The sessions bound to it followed it: still listed on its panel.
  await expect(page.getByTestId("map-agent-session-sess-boot")).toBeVisible();
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute("data-agent", "leasing");
});

test("a project with no agents opens the new-agent screen from its header (D36)", async ({
  page,
}) => {
  await page.getByTestId("project-select-scratch").click();
  await expect(page.getByTestId("session-project-chip")).toContainText("scratch");
  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
});

test("a drawn map opens in full view from the project header and Escape unwinds it", async ({
  page,
}) => {
  await page.goto("/?seed=0&mockStudioProjects=present&mockAgentMapGolden=1");
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  await expect(page.getByTestId("canvas-expand")).toHaveCount(1);
  await page.getByTestId("canvas-expand").click();
  await expect(page.getByTestId("agent-map-frame")).toHaveClass(/is-expanded/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-map-frame")).not.toHaveClass(/is-expanded/);
  await page.getByTestId("canvas-expand").click();
  await page.getByTestId("canvas-expand-exit").click();
  await expect(page.getByTestId("agent-map-frame")).not.toHaveClass(/is-expanded/);
  // Leaving the map leaves its full view behind; the session's canvas is not
  // handed an expanded frame.
  await page.getByTestId("canvas-expand").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("rail-session-select-sess-boot").click();
  await expect(page.locator(".canvas-frame-wrap.is-expanded")).toHaveCount(0);
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
