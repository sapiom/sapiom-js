/**
 * Mock-mode UI smoke test — runs against `vite dev` with VITE_MOCK=1 (see
 * playwright.config.ts), no harness server required. Fixtures live in
 * ../src/lib/mock-data.ts: 3 workflows (one deployed), a running "boot"
 * session (the server auto-creates one at launch), a second running
 * background session ("scratch", not the active tab on load — demonstrates
 * the tab strip and busy pulse), and 2 exited sessions kept around as
 * resumable history, 5 macros, and a small fake filesystem for the
 * new-session directory picker.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  activeSessionId,
  openProjectMap,
  selectSession,
  startChatWithRfq,
} from "./mock-navigation";

// The mock demo seeds a run + auto-plays the chat conversation on load (see
// the demo spec). These smoke tests exercise mechanics from a clean slate, so
// they opt out with ?seed=0 — the seeded end-state has its own coverage.
test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("renders the three panes plus the brand header, with no separate action rail", async ({
  page,
}) => {
  await expect(page.locator(".brand-header")).toBeVisible();
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.locator(".center-pane")).toBeVisible();
  await expect(page.locator(".session-bar")).toBeVisible();
  await expect(page.locator(".canvas-pane")).toBeVisible();

  // The action rail is retired — actions live on the selected workflow's
  // inline macro row in the rail, not in a standalone column.
  await expect(page.locator(".rail-actions")).toHaveCount(0);

  await page.screenshot({
    path: "web/e2e/screenshots/app-shell.png",
    fullPage: true,
  });
});

test("viewport-locked shell: the page never scrolls even when terminal content overflows", async ({
  page,
}) => {
  // Simulate a terminal that's rendered far more than the pane can show —
  // injected as a raw sibling in .terminal-slot (bypassing Terminal.tsx's own
  // overflow:hidden wrapper) so this also exercises the grid/flex containment
  // chain above it (.app, .center-pane), not just the terminal's own clipping.
  await page.evaluate(() => {
    const slot = document.querySelector(".terminal-slot");
    const filler = document.createElement("div");
    filler.setAttribute("data-testid", "scroll-stress-filler");
    filler.style.height = "6000px";
    slot?.appendChild(filler);
  });

  const root = await page.evaluate(() => {
    const el = document.scrollingElement as HTMLElement;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  expect(root.scrollHeight).toBe(root.clientHeight);
});

/** Flip the theme. Appearance lives in the account menu with the rest of the
 *  workspace preferences — the rail's chrome line is window controls and
 *  navigation now. */
async function toggleTheme(page: Page): Promise<void> {
  await page.getByTestId("brand-identity").click();
  await page.getByTestId("theme-toggle").click();
}

test.describe("theme — a manual choice overrides the light default and persists", () => {
  // Pin the OS to dark to prove it does not choose the initial theme. The toggle
  // then stores dark, which must survive a reload (persistence beats default).
  test.use({ colorScheme: "dark" });

  test("defaults to light, toggles to dark, and persists across reload", async ({
    page,
  }) => {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.screenshot({
      path: "web/e2e/screenshots/theme-light.png",
      fullPage: true,
    });

    await toggleTheme(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({
      path: "web/e2e/screenshots/theme-dark.png",
      fullPage: true,
    });

    await page.reload();
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await toggleTheme(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});

test.describe("theme — defaults to light until the user chooses", () => {
  // No stored choice → light, independent of the OS color scheme.
  test.describe("system prefers dark", () => {
    test.use({ colorScheme: "dark" });
    test("defaults to light", async ({ page }) => {
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    });
  });

  test.describe("system prefers light", () => {
    test.use({ colorScheme: "light" });
    test("defaults to light", async ({ page }) => {
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    });
  });
});

test("rail: the New project CTA leads the nav and runs the folder step", async ({
  page,
}) => {
  const cta = page.getByTestId("rail-new-project");
  await expect(cta).toBeVisible();
  // Says WHAT it creates (flow-creation.md §4.1, D27): a new agent lives in a
  // project, so the rail's verb is the project first.
  await expect(cta).toHaveText("New project");
  await expect(page.getByTestId("rail-create-new")).toHaveCount(0);
  await expect(page.getByTestId("add-existing-agents")).toHaveCount(0);

  // On the browser host the folder step is the one-field dialog; the screen
  // opens once the folder is chosen.
  await cta.click();
  await expect(page.getByTestId("project-folder-dialog")).toBeVisible();
  await page.getByTestId("folder-field-input").fill("/Users/demo/blank-slate");
  await page.getByTestId("project-folder-continue").click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
  await expect(page.getByTestId("new-agent-project")).toContainText("blank-slate");
});

test("brand header shows the Sapiom wordmark and the demo-workspace identity", async ({
  page,
}) => {
  await expect(page).toHaveTitle("Agent Studio");
  await expect(page.locator(".brand-logotype")).toBeVisible();
  await expect(page.locator(".brand-product")).toHaveText("agent.studio");
  await expect(page.getByTestId("palette-trigger")).toHaveAttribute(
    "aria-label",
    "Search sessions, agents, and paths",
  );
  // Mock mode is the static demo build: it must never claim a connected
  // Sapiom account — the identity chip reads "Demo workspace" instead.
  const identity = page.getByTestId("brand-identity");
  await expect(identity).toContainText("Demo workspace");
  await expect(page.locator(".identity-dot")).toHaveAttribute(
    "data-authenticated",
    "false",
  );
});

test("auto-selects the running boot session on initial load", async ({
  page,
}) => {
  // The server auto-creates a session in launchDir at boot — the app should
  // never open to an empty terminal pane.
  await expect(page.locator(".terminal-empty")).toHaveCount(0);
  const header = page.getByTestId("session-context");
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");
  // Its rail row is selected and wears the live mark.
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
    "data-mark",
    "live",
  );
});

test("session header: compact identity (name only; path in the tooltip)", async ({
  page,
}) => {
  const header = page.getByTestId("session-context");
  const title = header.getByTestId("session-context-title");
  // Browser-style sessions use the established session-name contract rather
  // than replacing the folder default with the bound agent's name.
  await expect(title).toHaveText("acme-app");
  // The full path never renders inline (it would bleed) — it lives in the
  // session menu's hover tooltip alongside the workspace label.
  await expect(header).not.toContainText("/Users/demo/acme-app");
  await expect(header.getByTestId("session-menu")).toHaveAttribute(
    "data-tooltip",
    /\/Users\/demo\/acme-app/,
  );

  await page.screenshot({ path: "web/e2e/screenshots/session-header.png" });
});

test("Cmd/Ctrl+1..9 selects the nth rail row of the selected session's project", async ({
  page,
}) => {
  const header = page.getByTestId("session-context");
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");

  // acme-app's rows, newest activity first: leasing-2 is 1, boot is 2.
  await page.keyboard.press("Meta+1");
  await expect(header).toHaveAttribute("data-session-id", "sess-leasing-2");

  await page.keyboard.press("Meta+2");
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");
});

test("the active session shows a busy pulse that clears once output goes quiet", async ({
  page,
}) => {
  // Session switching is inline now (no background tab strip), so the busy
  // pulse means the ACTIVE session is producing output. A session.activity ping
  // for the active session (sess-boot) lights its dot in the session bar.
  const header = page.getByTestId("session-context");
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "session.activity",
      harnessSessionId: "sess-boot",
    });
  });
  const busy = page.getByTestId("session-busy");
  await expect(busy).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: "web/e2e/screenshots/session-busy.png" });

  // The busy window (~3s) clears once no further activity arrives — the dot
  // returns to its plain live state.
  await expect(busy).toHaveCount(0, { timeout: 6_000 });
});

test("Overview heads the account menu and opens the introduction, naming the running build", async ({
  page,
}) => {
  // The introduction lives in the account menu now, not a pinned rail row —
  // one click deep but always available, not just on first run.
  await page.getByTestId("brand-identity").click();
  await expect(page.getByTestId("profile-menu")).toBeVisible();
  const item = page.getByTestId("rail-overview");
  await expect(item).toBeVisible();
  await item.click();

  // Selection closes the menu and opens the Overview modal — a standalone
  // introduction to the app, over the workbench.
  await expect(page.getByTestId("profile-menu")).toHaveCount(0);
  const overview = page.getByTestId("overview-modal");
  await expect(overview).toBeVisible();
  await expect(overview).toContainText("agent.studio");
  // "Which version am I running" is answerable without leaving the app.
  await expect(page.getByTestId("overview-version")).toContainText(/^v\d/);
});

test("Overview opens the introduction, and Escape returns to the session behind it", async ({
  page,
}) => {
  // The Overview is a modal over the workbench: dismissing it returns to the
  // session it opened over, and leaves that session untouched.
  await page.getByTestId("brand-identity").click();
  await page.getByTestId("rail-overview").click();
  await expect(page.getByTestId("overview-modal")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("overview-modal")).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-boot",
  );
});

test("creation IA: Add project is one folder question; a project's + starts a chat directly", async ({
  page,
}) => {
  // Adding a folder is ONE question, asked once, with no detection, no doors
  // and no agent picker (flow-creation.md §4.5, D28).
  await page.getByTestId("rail-add-project").click();
  const modal = page.getByTestId("project-folder-dialog");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("add-menu")).toHaveCount(0);
  await expect(page.getByTestId("aw-doors")).toHaveCount(0);
  await expect(modal.locator(".folder-field")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  // A project header's + means another conversation in this project. The
  // rail's New project remains the entry for a new project and its agent.
  const newBtn = page.getByTestId("project-new-chat-acme-app");
  await expect(newBtn).toHaveAttribute("aria-label", "New chat in acme-app");
  await newBtn.click();
  await expect(
    page.getByTestId("rail-project-acme-app").locator(".rail-session-row"),
  ).toHaveCount(6);
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect(page.getByTestId("project-folder-dialog")).toHaveCount(0);
});

test("the selected session's bound agent drives macro gating", async ({
  page,
}) => {
  // The rail lists sessions, not agents (flow-navigation.md Q3).
  await expect(page.locator(".rail-workflows [data-testid^='workflow-']")).toHaveCount(0);

  // "leasing" is deployed (has a definitionId) and is the boot session's
  // binding — action bar is live and Prod Run is enabled.
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
    "data-agent",
    "leasing",
  );
  await page.getByRole("button", { name: "Choose run target" }).click();
  const prodRun = page.getByTestId("session-step-run");
  await expect(prodRun).toBeEnabled();
  await page.keyboard.press("Escape");

  // The open_prod button has been removed from the action bar (SAP-1899);
  // the deployed pill (→ dashboard) now lives in the canvas tab bar for deployed workflows.
  await expect(page.getByTestId("macro-open_prod")).toHaveCount(0);

  // Looking at "rfq" on its project's map starts nothing: the project view
  // has no session, so there is no action bar to gate.
  await openProjectMap(page, "rfq-agent");
  await expect(prodRun).toHaveCount(0);

  // Start chat binds a new session to rfq (undeployed) and brings the action
  // bar live, gated with a reason distinct from "no workflow selected".
  await startChatWithRfq(page);
  await page.getByRole("button", { name: "Choose run target" }).click();
  await expect(prodRun).toBeDisabled();
  await expect(prodRun).toHaveAttribute("title", "Not deployed yet");

  // The gating reason is carried by the disabled Cloud target while Local
  // remains the split control's available fallback.
  await expect(page.getByTestId("session-step-local")).toHaveAccessibleName(
    "Run using Local",
  );
  await page.screenshot({
    path: "web/e2e/screenshots/workflow-macros-gated.png",
  });
});

test("inject macros are enabled once the boot session and a deployed workflow are active", async ({
  page,
}) => {
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
    "data-agent",
    "leasing",
  );
  await expect(page.getByTestId("session-step-local")).toBeEnabled();
  await expect(page.getByTestId("session-step-deploy")).toBeEnabled();
});

test.describe("three-zone IA (Project › Sessions rail, one centre, right pane)", () => {
  test("Studio rail is project > sessions, with no agent rows", async ({
    page,
  }) => {
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
    await expect(page.getByTestId("workspace-group-rfq-agent")).toBeVisible();
    // onboarding-flow is a known project (in recentDirs): header and + only.
    await expect(
      page.getByTestId("workspace-group-onboarding-flow"),
    ).toBeVisible();
    await expect(
      page.getByTestId("rail-project-onboarding-flow").locator(".rail-session-row"),
    ).toHaveCount(0);
    await expect(page.getByTestId("project-new-chat-onboarding-flow")).toBeVisible();

    // No agent rows and no deploy glyphs in the rail: agents live on the map.
    await expect(page.locator(".rail-workflows [data-testid^='workflow-']")).toHaveCount(0);
    await expect(page.getByTestId("rail-session-sess-boot")).toBeVisible();
    await expect(page.getByTestId("rail-session-sess-rfq")).toBeVisible();
    await expect(page.getByTestId("project-select-scratch")).toBeVisible();

    // Exactly one filled row: the selected session (boot on load).
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(page.locator(".rail-list .workspace-row.is-selected")).toHaveCount(1);

    await page.screenshot({
      path: "web/e2e/screenshots/rail-explorer.png",
      fullPage: true,
    });
  });

  test("a project's sessions are rows under it, newest activity first, with no tab strip", async ({
    page,
  }) => {
    const header = page.getByTestId("session-context");
    await expect(header).toHaveAttribute("data-session-id", "sess-boot");
    const rows = page.getByTestId("rail-project-acme-app").locator(".rail-session-row");
    await expect(rows.nth(0)).toHaveAttribute("data-testid", "rail-session-sess-leasing-2");
    await expect(rows.nth(1)).toHaveAttribute("data-testid", "rail-session-sess-boot");
    await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
    await expect(page.locator(".session-tabs")).toHaveCount(0);
    await expect(page.getByTestId("session-menu")).toBeVisible();
  });

  test("switching sessions makes the canvas follow the new session's content", async ({
    page,
  }) => {
    // The right pane is the selected session's bound agent. sess-boot ships a
    // bundled doc (board); the second leasing session ships none, so its pane
    // shows the empty state. The pane's open state is the user's, so it stays
    // open across the switch.
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      "sess-boot",
    );
    await expect(page.locator(".canvas-iframe")).toBeVisible();
    await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);

    await selectSession(page, "sess-leasing-2");
    await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
    await expect(page.locator(".canvas-iframe")).toHaveCount(0);

    await selectSession(page, "sess-boot");
    await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  });

  test("a project's + starts a fresh session at its root without opening the composer", async ({
    page,
  }) => {
    await page.getByTestId("project-new-chat-acme-app").click();
    await expect(
      page.getByTestId("rail-project-acme-app").locator(".rail-session-row"),
    ).toHaveCount(6);
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
    await expect.poll(() => activeSessionId(page)).not.toBe("sess-boot");
  });

  test("ending the active session confirms, then keeps it selected as exited", async ({
    page,
  }) => {
    // Ending a session kills a PTY, so the End action opens the shared confirm
    // first — reached from the session's title menu.
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      "sess-boot",
    );
    await page.getByTestId("session-menu").click();
    await page.getByTestId("session-end-btn").click();
    const confirm = page.getByTestId("end-session-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("kills the live terminal");

    // Keep cancels — nothing dies.
    await page.getByRole("button", { name: "Keep session" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
      "data-mark",
      "live",
    );

    // Confirming ends it; it stays selected, as ended (D43), on its dead pane.
    await page.getByTestId("session-menu").click();
    await page.getByTestId("session-end-btn").click();
    await page.getByTestId("end-session-confirm-btn").click();
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
      "data-mark",
      "exited",
    );
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      "sess-boot",
    );
    await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  });

  test("an agent with no session is one Start chat away on its project's map", async ({
    page,
  }) => {
    // rfq has no live session. Its project's map lists it; its panel says it
    // has none yet, and Start chat runs the create+bind path in rfq's OWN
    // project (never borrowing the acme-app session).
    await openProjectMap(page, "rfq-agent");
    await page.getByTestId("map-agent-rfq").click();
    await expect(page.getByTestId("map-agent-panel")).toHaveAttribute("data-agent", "rfq");
    // The panel lists only rfq's own LIVE-or-recent bound sessions; the exited
    // fixture session is unbound, so none.
    await expect(page.getByTestId("map-agent-sessions-empty")).toBeVisible();

    const id = await startChatWithRfq(page);
    // The session gets the folder's next default title: the exited fixture
    // session keeps "rfq-agent", so this one is "rfq-agent 2".
    await expect(page.getByTestId("session-context-title")).toHaveText(
      "rfq-agent 2",
    );
    await expect(page.locator(".harness-terminal")).toBeVisible();
    // The right pane is rfq's: the boot session's board is not drawn there
    // (rfq's new session has nothing generated yet).
    await expect(page.locator(".canvas-iframe")).toHaveCount(0);
    await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");
    await expect(page.getByTestId(`rail-session-${id}`)).toHaveAttribute("data-agent", "rfq");
  });

  test("the mapping invariant: selected session == its bound agent == right-pane subject", async ({
    page,
  }) => {
    // On load: boot is selected, bound to leasing, and the right pane renders
    // leasing's board.
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
      "data-agent",
      "leasing",
    );
    await expect(page.getByTestId("session-context-title")).toHaveText(
      "acme-app",
    );
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    // Start a chat with rfq: the selection, the binding and the pane move
    // together to rfq.
    const id = await startChatWithRfq(page);
    await expect(page.getByTestId(`rail-session-${id}`)).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("rail-session-sess-boot")).not.toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(page.getByTestId("session-context-title")).toHaveText(
      "rfq-agent 2",
    );
    // Still exactly one filled row.
    await expect(page.locator(".rail-list .workspace-row.is-selected")).toHaveCount(1);
  });

  test("session naming: rename from the header menu, persisted across reloads", async ({
    page,
  }) => {
    // Header ⋯ menu → Rename session: the title becomes an inline input.
    await page.getByTestId("session-menu").click();
    await page.getByTestId("session-rename").click();
    const input = page.getByTestId("session-rename-input");
    await expect(input).toHaveValue("acme-app");
    await input.fill("Leasing revamp");
    await input.press("Enter");
    // The active session's label (the header identity) follows the rename.
    await expect(page.getByTestId("session-context-title")).toHaveText(
      "Leasing revamp",
    );

    // Client-side persistence (docs/GAPS.md): survives a reload.
    await page.reload();
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-context-title")).toHaveText(
      "Leasing revamp",
    );
  });

  test("the boot session keeps its folder-derived session label on load", async ({
    page,
  }) => {
    const title = page.getByTestId("session-context-title");
    await expect(title).toBeVisible();
    await expect(title).toHaveText("acme-app");
  });

  test("the binding is per-session: an exited session under review keeps its own title, not the agent binding", async ({
    page,
  }) => {
    await expect(page.getByTestId("session-context-title")).toHaveText(
      "acme-app",
    );

    // Select an exited session that never had anything bound (from the merged
    // past-sessions list) — it opens as a dead session reviewed under its own
    // transcript title, carrying none of the boot session's binding.
    await page.getByTestId("rail-history").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await expect(page.getByTestId("dead-session-pane")).toBeVisible();
    await expect(page.getByTestId("session-context-title")).toHaveText(
      "Build the leasing pipeline",
    );
  });
});

test("Add project: the folder field completes a path and drives the one action", async ({
  page,
}) => {
  await page.getByTestId("rail-add-project").click();
  const modal = page.getByTestId("project-folder-dialog");
  await expect(modal).toBeVisible();

  const input = page.getByTestId("folder-field-input");
  // NO PRE-CHOSEN PARENT (flow-creation.md Q8): the field opens empty.
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("project-folder-continue")).toBeDisabled();

  /* NO IN-APP FILE BROWSER. The path bar, the up-one-level button and the
     scrolling folder list are gone: on desktop the OS folder browser is the
     picker, and this — a browser host — gets the field plus a native
     `<datalist>`, which is the smallest fallback that still completes a path. */
  await expect(modal.locator(".dir-picker-listing")).toHaveCount(0);
  await expect(page.getByTestId("folder-field-options")).toHaveCount(1);
  // And no Choose button here: a browser has no bridge, and a control that
  // cannot work must never be shown.
  await expect(page.getByTestId("folder-field-choose")).toHaveCount(0);

  await page.screenshot({
    path: "web/e2e/screenshots/add-project.png",
  });

  // A folder that exists can be added; one that does not cannot, and says so.
  await input.fill("/Users/demo/scratch");
  await expect(page.getByTestId("project-folder-continue")).toBeEnabled();
  await input.fill("/Users/demo/scratch/brand-new-thing");
  await expect(page.getByTestId("project-folder-hint")).toHaveText(
    "That folder doesn't exist yet.",
  );
  await expect(page.getByTestId("project-folder-continue")).toBeDisabled();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toBeHidden();
});

test("Add project: a failed directory read is reported, not swallowed", async ({
  page,
}) => {
  // ?mockError=listDir makes the filesystem probe reject.
  await page.goto("/?mockError=listDir&seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();

  await page.getByTestId("rail-add-project").click();
  const modal = page.getByTestId("project-folder-dialog");
  await expect(modal).toBeVisible();
  await page.getByTestId("folder-field-input").fill("/Users/demo/scratch");

  const err = page.getByTestId("project-folder-error");
  await expect(err).toBeVisible({ timeout: 3_000 });
  await expect(err).toContainText("Couldn't read that directory");

  // And the dialog offers nothing it cannot do: an unreadable folder cannot be
  // added.
  await expect(page.getByTestId("project-folder-continue")).toBeDisabled();
});

test("command palette: a failed path read shows an error but still offers the typed path", async ({
  page,
}) => {
  await page.goto("/?mockError=listDir&seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();

  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-input").fill("/Users/demo");

  const err = page.getByTestId("command-palette-error");
  await expect(err).toBeVisible({ timeout: 3_000 });
  await expect(err).toContainText("Couldn't read that path");

  // The "open this path" confirm row is still available despite the failure.
  await expect(page.getByTestId("command-palette-item-0")).toContainText(
    "Open this path",
  );
});

test("a past-session row opens the dead-session pane first; Resume is the explicit action", async ({
  page,
}) => {
  await page.getByTestId("rail-history").click();
  await page.getByTestId("exited-session-sess-leasing").click();

  // One click = review the dead session. Nothing resumes silently.
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  const header = page.getByTestId("session-context");
  await expect(header).toHaveAttribute("data-session-id", "sess-leasing");

  await page.getByTestId("dead-session-resume").click();
  await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
  await expect(header).toHaveAttribute("data-session-id", "sess-leasing");
  await expect(header.getByTestId("session-context-title")).toContainText(
    "Build the leasing pipeline",
  );

  // The resumed session is live again: its rail row is selected and live.
  await expect(page.getByTestId("rail-session-sess-leasing")).toHaveAttribute(
    "data-mark",
    "live",
  );
  await expect(page.getByTestId("rail-session-sess-leasing")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(header.getByTestId("session-context-title")).toContainText(
    "Build the leasing pipeline",
  );
});

test("Past sessions is ONE merged list beside the rail, opened from the history glyph", async ({
  page,
}) => {
  // The options menu orders the projects and holds nothing else
  // (flow-creation.md §4.7, Q9): no Past sessions row, no count badge.
  await page.getByTestId("history-trigger").click();
  const menu = page.getByTestId("rail-options-menu");
  await expect(menu).toBeVisible();
  await expect(menu).not.toContainText("Past sessions");
  await expect(page.getByTestId("past-sessions-trigger")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByTestId("rail-history").click();
  const card = page.getByTestId("history-menu");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("past-sessions-card")).toBeVisible();
  // One list — the old Exited/History split is gone.
  await expect(card.getByText("Exited", { exact: true })).toHaveCount(0);
  await expect(card.getByText("History", { exact: true })).toHaveCount(0);

  // The registry's exited session renders ONCE (deduped against its own
  // history mirror) and resolves to a real resume.
  const exited = page.getByTestId("exited-session-sess-leasing");
  await expect(exited).toBeVisible();
  await expect(
    page.getByTestId("history-8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f"),
  ).toHaveCount(0);
  await expect(card.getByText("Build the leasing pipeline")).toHaveCount(1);
  await expect(exited).toHaveAttribute("data-resumable", "true");
  // An ordinary resume carries no state word — only the exceptions speak.
  await expect(exited).not.toContainText("from summary");
  await expect(exited).not.toContainText("nothing recorded");

  // The list is global — rfq-agent's past session shows without
  // switching directories.
  await expect(page.getByTestId("exited-session-sess-rfq")).toBeVisible();

  // A transcript entry carries branch, turn count, and relative time. Its
  // transcript really is on disk, so the server reports agent-resume and the
  // row is tagged resumable — it used to be hardcoded "archived" regardless.
  //
  // The turn count is OUR event index's exact count (turnCount: 3), which
  // outranks the vendor transcript scan's messageCount (12) that the same
  // fixture also carries.
  const transcript = page.getByTestId(
    "history-2b6d9e10-7711-4c2a-8b0a-9e4f2d1c5a33",
  );
  await expect(transcript).toHaveAttribute("data-resumable", "true");
  await expect(transcript).toContainText("feat/screening-webhook");
  await expect(transcript).toContainText("3 turns");
  await expect(transcript).not.toContainText("12 turns");
  await expect(transcript).toContainText("ago");

  await page.screenshot({ path: "web/e2e/screenshots/past-sessions-card.png" });

  // Clicking the transcript entry opens the review pane — nothing starts
  // silently; resuming is the pane's explicit, honestly-labeled action.
  await transcript.click();
  const pane = page.getByTestId("past-session-pane");
  await expect(pane).toBeVisible();
  await expect(page.getByTestId("session-context-title")).toHaveText(
    "Wire the screening webhook",
  );
  await expect(page.getByTestId("past-session-start")).toHaveText("Resume");
  // Resumable → no "we can't reattach" disclaimer to show.
  await expect(page.getByTestId("past-session-reason")).toHaveCount(0);

  // Adopted into the registry and resumed for real — NOT a fresh sess-mock
  // session, which is what the hardcoded resumable={false} used to force.
  await page.getByTestId("past-session-start").click();
  await expect(page.getByTestId("past-session-pane")).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    /sess-adopted/,
  );
});

test("a phantom past session reads 'nothing recorded' and never offers Resume", async ({
  page,
}) => {
  // sess-phantom holds an agentSessionId (our SessionStart hook fired) but the
  // agent wrote no transcript, because the session ended before its first
  // prompt. On one real machine 16 of 49 registry rows measured this shape, and
  // every one rendered "resumable" and failed with exit 1 on click.
  await page.getByTestId("rail-history").click();
  await expect(page.getByTestId("past-sessions-card")).toBeVisible();

  const phantom = page.getByTestId("exited-session-sess-phantom");
  await expect(phantom).toBeVisible();
  await expect(phantom).toHaveAttribute("data-resumable", "false");
  // "nothing recorded", not "archived": nothing was archived, and the word used
  // to be shared with rows that DO have a recorded conversation to rebuild from.
  await expect(phantom).toContainText("nothing recorded");
  await expect(phantom).not.toContainText("from summary");

  // A genuinely resumable row in the same directory still reads resumable —
  // the tag reflects a per-row probe, not a blanket downgrade.
  await expect(page.getByTestId("exited-session-sess-leasing")).toHaveAttribute(
    "data-resumable",
    "true",
  );

  // Opening it lands on the dead pane with Resume disabled and the real reason
  // stated, rather than a live Resume button and a bare "exit code 1".
  await phantom.click();
  const pane = page.getByTestId("dead-session-pane");
  await expect(pane).toBeVisible();
  await expect(page.getByTestId("dead-session-resume")).toBeDisabled();
  const reason = page.getByTestId("dead-session-resume-reason");
  await expect(reason).toContainText("no saved conversation");
  await expect(reason).toContainText("before its first prompt");

  await page.screenshot({
    path: "web/e2e/screenshots/phantom-session-pane.png",
  });
});

test.describe("dead sessions never trap the user", () => {
  test("an exited session is reachable from the history menu and shows a dead-session pane, not a stuck terminal", async ({
    page,
  }) => {
    await page.getByTestId("rail-history").click();
    await page.getByTestId("exited-session-sess-leasing").click();

    const pane = page.getByTestId("dead-session-pane");
    await expect(pane).toBeVisible();
    await expect(pane).toContainText("Session exited");
    await expect(pane).toContainText("exit code 0");
    await expect(page.locator(".harness-terminal")).toHaveCount(0);

    await page.screenshot({
      path: "web/e2e/screenshots/dead-session-pane.png",
      fullPage: true,
    });
  });

  test("Resume on a dead session starts it running again and stays active in the header", async ({
    page,
  }) => {
    await page.getByTestId("rail-history").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await page.getByTestId("dead-session-resume").click();

    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    const header = page.getByTestId("session-context");
    await expect(header).toHaveAttribute("data-session-id", "sess-leasing");
    await expect(header.getByTestId("session-context-title")).toContainText(
      "Build the leasing pipeline",
    );
  });

  test("Close on a dead session hides it from the rail and shows its project's map; History keeps it", async ({
    page,
  }) => {
    await page.getByTestId("rail-history").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await page.getByTestId("dead-session-close").click();

    // Close on an ended session is the rail's × on its row (flow Q4): hidden
    // from the rail, and the centre moves to its project's map.
    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    await expect(page.getByTestId("rail-session-sess-leasing")).toHaveCount(0);
    await expect(page.getByTestId("project-map-pane")).toBeVisible();

    await page.getByTestId("rail-history").click();
    await expect(page.getByTestId("past-sessions-card")).toBeVisible();
    await expect(page.getByTestId("exited-session-sess-leasing")).toBeVisible();
  });
});

test("the rail's options menu offers Sort by only: no Group axis", async ({
  page,
}) => {
  await expect(page.getByTestId("rail-view-toggle")).toHaveCount(0);
  await expect(page.locator("[data-testid^='custom-group-']")).toHaveCount(0);

  await page.getByTestId("history-trigger").click();
  await expect(page.getByTestId("rail-options-menu")).toBeVisible();
  // One axis now (flow-navigation.md Q8): Sort by, never Group by.
  await expect(page.getByTestId("filing-group-by")).toHaveCount(0);
  await expect(page.getByTestId("sort-recent")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("sort-name")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("sort-name").click();
  await expect(page.getByTestId("sort-name")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // Projects are headers; agents are not rail rows.
  await expect(
    page.getByTestId("workspace-group-onboarding-flow"),
  ).toBeVisible();
  await expect(page.getByTestId("workflow-onboarding-flow")).toHaveCount(0);
});

test.describe("held arrangement", () => {
  test("project collapse and the right tab survive a reload", async ({
    page,
  }) => {
    // Collapse through the dedicated disclosure. The project label is a
    // navigation target and must never fold the hierarchy as a side effect.
    await page.getByTestId("project-disclosure-acme-app").click();
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveCount(0);

    // Pick the Steps tab.
    await page.getByTestId("right-tab-steps").click();

    await page.reload();
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Restored: the project stays folded and the pane still remembers the Steps
    // tab.
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveCount(0);
    await expect(page.getByTestId("right-tab-steps")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

test("rail tooltips fly to the right of the rail instead of covering sibling rows", async ({
  page,
}) => {
  await page.getByTestId("project-select-acme-app").hover();
  const tip = page.locator(".app-tooltip");
  await expect(tip).toHaveAttribute("data-show", "true");

  const railBox = await page.locator(".rail-workflows").boundingBox();
  const tipBox = await tip.boundingBox();
  expect(tipBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  // Flush right of the rail edge — never on top of the tree.
  expect(tipBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width);
});

test("Open in editor lives on the session menu, and names the chosen editor", async ({
  page,
}) => {
  // Session ⋯ menu item. It says which editor it will hand the folder to,
  // because nothing reports back if that editor isn't installed.
  await page.getByTestId("session-menu").click();
  await expect(page.getByTestId("session-open-editor")).toContainText(
    "Open in VS Code",
  );
  await page.keyboard.press("Escape");

  // Picking another editor in Settings retargets the item — the VS Code
  // hardcoding is what made this useless on a Cursor-only machine.
  await page.getByTestId("brand-identity").click();
  await page.getByTestId("settings-trigger").click();
  await page.getByTestId("editor-select").selectOption("cursor");
  await page.keyboard.press("Escape");

  await page.getByTestId("session-menu").click();
  await expect(page.getByTestId("session-open-editor")).toContainText(
    "Open in Cursor",
  );
});

test.describe("command palette (Cmd+K / Cmd+P quick-jump)", () => {
  test("opens via the header trigger and the keyboard shortcut, listing sessions/workflows/recents by default", async ({
    page,
  }) => {
    await page.getByTestId("palette-trigger").click();
    const list = page.getByTestId("command-palette-list");
    await expect(list).toBeVisible();
    await expect(page.getByTestId("command-palette-item-0")).toContainText(
      "acme-app",
    ); // the running boot session

    await page.screenshot({ path: "web/e2e/screenshots/command-palette.png" });

    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();

    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-palette-list")).toBeVisible();
  });

  test("fuzzy filters by the typed query", async ({ page }) => {
    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("leasing");
    await expect(page.getByTestId("command-palette-item-0")).toContainText(
      "leasing",
    );
  });

  test("Enter on a workflow hit starts a new session there", async ({
    page,
  }) => {
    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("onboarding-flow");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("session-context-title")).toContainText(
      "onboarding-flow",
    );
  });

  test("Enter on a session hit switches to it instead of starting a new one", async ({
    page,
  }) => {
    // Resume a different session first so switching back is observable
    // (review pane first, then the explicit Resume).
    await page.getByTestId("rail-history").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await page.getByTestId("dead-session-resume").click();
    const header = page.getByTestId("session-context");
    await expect(header).toHaveAttribute("data-session-id", "sess-leasing");

    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("acme-app");
    await page.getByTestId("command-palette-item-0").click();
    await expect(header).not.toHaveAttribute("data-session-id", "sess-leasing");
  });

  test("a path-shaped query uses live GET /api/fs/list completion instead of fuzzy matching", async ({
    page,
  }) => {
    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("/Users/demo");

    await expect(page.getByText("Open this path")).toBeVisible();
    const dirItem = page.getByTestId("command-palette-item-1");
    await expect(dirItem).toContainText("acme-app");

    await dirItem.click();
    await expect(page.getByTestId("session-context-title")).toContainText(
      "acme-app",
    );
  });
});

test("canvas pane shows its empty state for a session with nothing generated yet", async ({
  page,
}) => {
  // The boot session opens on its bundled board (first paint), so switch to
  // the second leasing session — bound, no bundled doc — to see the honest
  // empty state. (scratch is unbound, so it has no right pane at all.)
  await selectSession(page, "sess-leasing-2");
  await expect(page.locator(".canvas-empty")).toContainText(
    "Nothing generated yet",
  );
  await expect(page.locator(".canvas-empty")).toContainText(
    "Generated automatically from the bound agent",
  );
});

test("settings popover: identity, telemetry toggle, and it persists across close/reopen", async ({
  page,
}) => {
  await page.getByTestId("brand-identity").click();
  const trigger = page.getByTestId("settings-trigger");
  const toggle = page.getByTestId("telemetry-toggle");

  await trigger.click();
  const popover = page.getByTestId("settings-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Acme (mock)");
  await expect(popover).toContainText("events.ndjson");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // Reopening should reflect the same (mutated) state, not reset to the fixture default.
  await page.getByTestId("brand-identity").click();
  await trigger.click();
  await expect(page.getByTestId("telemetry-toggle")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test.describe("workflow actions", () => {
  test("project headers carry no macro strip and show their full untruncated name", async ({
    page,
  }) => {
    // The rail lists no agent rows (Q3); a project header is [mark][name][+]
    // only. "onboarding-flow" is the longest fixture name; it must not clip.
    const row = page.getByTestId("workspace-group-onboarding-flow");
    await expect(row.getByTestId("workflow-macros")).toHaveCount(0);
    const name = row.locator(".tree-row-label");
    await expect(name).toHaveText("onboarding-flow");
    const overflowing = await name.evaluate(
      (el) => el.scrollWidth > el.clientWidth + 1,
    );
    expect(overflowing).toBe(false);
  });

  test("action bar shows the unified split Run control; the Prod globe stays; the deployed pill links to the dashboard", async ({
    page,
  }) => {
    // The main segment opens the last available target; the menu makes both
    // Local and Cloud explicit without separate Test/Run buttons.
    const localBtn = page.getByTestId("session-step-local");
    await expect(localBtn).toBeVisible();
    await expect(localBtn).toContainText("Run · Local");
    await page.getByRole("button", { name: "Choose run target" }).click();
    await expect(
      page.getByRole("menuitemradio", { name: /Local/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitemradio", { name: /Cloud/ }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");

    // Prod is a real destination (the globe shortcut), not a removed button.
    await expect(page.getByTestId("session-step-prod")).toBeVisible();
    // The old open_prod macro button is gone from the action bar.
    await expect(page.getByTestId("macro-open_prod")).toHaveCount(0);

    // Rail workflow rows still carry no macro strips — the wizard owns them.
    await expect(page.getByTestId("workflow-macros")).toHaveCount(0);

    // The deployed pill doubles as the dashboard link and sits in the canvas
    // tab bar for deployed workflows. leasing is deployed (definitionId set) on load.
    await page.getByTestId("right-tab-canvas").click();
    const dashLink = page.getByTestId("workflow-dashboard-link");
    await expect(dashLink).toBeVisible();
    await expect(dashLink).toHaveAttribute("href", /app\.sapiom\.ai\/agents\//);
    await expect(dashLink).toHaveAttribute("target", "_blank");
  });

  test("the canvas tab bar stays fully on-screen even when the app is narrower than the default pane widths", async ({
    page,
  }) => {
    // Rail (320 default, shrinkable to 180) + terminal/canvas floors (20rem
    // each) exceed 900px at their preferred widths — narrower viewports used
    // to overflow .app's right edge and get silently clipped by its old
    // overflow:hidden.
    await page.setViewportSize({ width: 900, height: 640 });
    await page.waitForTimeout(50);

    // The canvas pane's top chrome is the tab bar now (Canvas/Steps/Code + the
    // deployed pill + expand/collapse) — the board dropped its subheader. The
    // bar spans the pane, so its right edge is the sentinel for h-overflow.
    const tabBar = page.locator(".right-pane-tabs");
    await expect(tabBar).toBeVisible();

    const tabBarBox = await tabBar.boundingBox();
    expect(tabBarBox).not.toBeNull();
    expect((tabBarBox?.x ?? 0) + (tabBarBox?.width ?? 0)).toBeLessThanOrEqual(
      900,
    );

    await page.screenshot({
      path: "web/e2e/screenshots/narrow-viewport-header.png",
      fullPage: true,
    });
  });
});

test("canvas empty state explains itself — no manual render action", async ({
  page,
}) => {
  // The second leasing session has no bundled doc, so its Canvas is the empty
  // state (the boot session opens on its board).
  await selectSession(page, "sess-leasing-2");
  await expect(page.locator(".canvas-empty")).toContainText(
    "Nothing generated yet",
  );
  // Short supporting line, no file-editing instructions (there is no editor in
  // this harness). The diagram generates automatically from the bound agent
  // — there is no manual render button anymore.
  await expect(page.locator(".canvas-empty")).toContainText(
    "Generated automatically from the bound agent",
  );
  await expect(page.locator(".canvas-empty")).not.toContainText(
    ".sapiom/canvas/index.html",
  );
  await expect(page.getByTestId("canvas-visualize-cta")).toHaveCount(0);

  await page.screenshot({ path: "web/e2e/screenshots/canvas-empty-state.png" });
});

test("steps tab shows its own empty state (not canvas copy) before anything is rendered", async ({
  page,
}) => {
  // The second leasing session has no generated canvas content, so the Steps
  // tab hits the same early-return state as the board — but must talk about
  // steps. (The boot session opens on its board, which does post a step graph.)
  await selectSession(page, "sess-leasing-2");
  await page.getByTestId("right-tab-steps").click();
  const empty = page.locator(".canvas-empty");
  await expect(empty).toContainText("No steps yet");
  await expect(empty).toContainText("Steps are read from the bound agent");
  await expect(empty).not.toContainText("Nothing generated yet");
  await expect(page.getByTestId("canvas-visualize-cta")).toHaveCount(0);

  // The board keeps its own copy on the Canvas tab.
  await page.getByTestId("right-tab-canvas").click();
  await expect(empty).toContainText("Nothing generated yet");
});

test("the canvas is a single controlled surface — no separate preview tab or port suggestions", async ({
  page,
}) => {
  await expect(page.locator(".canvas-mode-toggle")).toHaveCount(0);
  await expect(page.getByTestId("preview-chip")).toHaveCount(0);

  // A detected-port bus message must render nothing in this surface — the
  // canvas only ever shows the session's own generated content.
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "port.detected",
      harnessSessionId: "sess-boot",
      port: 4000,
      url: "http://localhost:4000",
    });
  });
  await expect(page.getByTestId("preview-chip")).toHaveCount(0);
  // The port message changed nothing in the canvas — the board (the session's
  // own generated content, rendered on first paint) is still all it shows.
  await expect(page.locator(".canvas-iframe")).toBeVisible();
});

test("the seeded boot agent renders its board on first paint, and a canvas.reload keeps the iframe", async ({
  page,
}) => {
  // Demo visibility (docs/IA.md): the agent bound to sess-boot renders its
  // board immediately — sess-boot ships a bundled canvas doc, so the demo
  // opens on a live board (no click) rather than an empty pane. Non-doc mock
  // sessions never mount an iframe (guarded elsewhere); this is the doc case.
  await expect(page.locator(".canvas-empty")).toHaveCount(0);
  await expect(page.locator(".canvas-iframe")).toHaveAttribute(
    "src",
    /^\/canvas\/sess-boot\/index\.html\?theme=(light|dark)$/,
  );

  // A canvas.reload (the real server fires one when the render is rewritten)
  // re-renders in place — the iframe stays, never dropping to the empty state.
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });

  await expect(page.locator(".canvas-empty")).toHaveCount(0);
  await expect(page.locator(".canvas-iframe")).toBeVisible();
});

test("a stale enrichment renders with the 'stale — Refresh' chip in the served canvas document", async ({
  page,
}) => {
  // The chip is server-rendered (core/canvas-render.ts marks an enrichment
  // whose fingerprint no longer matches the sources) — serve the REAL
  // renderer's output for that state into the pane's iframe and assert the
  // chip actually displays through the sandboxed-iframe pipeline.
  // Frontend-only port: the real server renderer lives upstream
  // (sapiom-js packages/harness/src/core/canvas-render.ts). This inline
  // fixture reproduces its stale-enrichment markup contract exactly
  // (.canvas-badge--stale chip + .canvas-subtitle stays displayed).
  const staleDocument = `<!doctype html><html><head><meta charset="utf-8" /></head><body>
    <div class="canvas-panel">
      <h1 class="canvas-title">leasing <span class="canvas-badge canvas-badge--stale">stale \u2014 Refresh</span></h1>
      <p class="canvas-subtitle">Handles lease applications end to end</p>
    </div>
  </body></html>`;
  await page.route("**/canvas/sess-boot/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: staleDocument });
  });

  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });

  const frame = page.frameLocator(".canvas-iframe");
  await expect(frame.locator(".canvas-badge--stale")).toHaveText(
    "stale — Refresh",
  );
  // The stale enrichment stays DISPLAYED — the chip marks it, never hides it.
  await expect(frame.locator(".canvas-subtitle")).toHaveText(
    "Handles lease applications end to end",
  );
});

test("a pending canvas load shows a skeleton over the iframe — never a blank pane", async ({
  page,
}) => {
  // Stall the canvas document so the load stays pending long enough to assert
  // on the skeleton deterministically.
  let releaseCanvas = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseCanvas = resolve;
  });
  await page.route("**/canvas/sess-boot/**", async (route) => {
    await gate;
    await route.fulfill({
      contentType: "text/html",
      body: "<html><body>diagram</body></html>",
    });
  });

  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });

  // While the iframe document is in flight: shimmer skeleton visible (with
  // its a11y label).
  await expect(page.getByTestId("canvas-loading")).toBeVisible();
  await expect(page.getByTestId("canvas-loading")).toHaveAttribute(
    "aria-label",
    "Rendering diagram",
  );

  // Once loaded the skeleton fades out (kept mounted briefly with .is-fading)
  // and then unmounts.
  releaseCanvas();
  await expect(page.getByTestId("canvas-loading")).toHaveCount(0, {
    timeout: 5_000,
  });
  await expect(page.locator(".canvas-iframe")).toBeVisible();
});

test("a mock session without a bundled canvas doc shows the empty state and never mounts an iframe", async ({
  page,
}) => {
  // Mock mode ships real documents only under public/canvas/<id>/ (today:
  // sess-boot). Any other session's canvas URL is the static host's 404
  // page on the deployed Pages build, so the pane must keep the honest
  // empty state — no iframe, and no fetch of a non-doc canvas URL, ever.
  const sessionsFetched = new Set<string>();
  await page.route("**/canvas/**", async (route) => {
    const match = /\/canvas\/([^/]+)/.exec(route.request().url());
    if (match) sessionsFetched.add(match[1]);
    await route.fulfill({
      contentType: "text/html",
      body: "<html><body>diagram</body></html>",
    });
  });

  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-iframe")).toBeVisible();

  // Start a chat with rfq: it starts in rfq-agent — a session with NO bundled
  // demo document.
  await startChatWithRfq(page);
  await expect(page.getByTestId("session-context-title")).toContainText("rfq");

  // Honest absence, not a 404 in a frame: the empty state renders…
  await expect(page.locator(".canvas-empty")).toContainText(
    "Nothing generated yet",
  );
  await expect(page.locator(".canvas-iframe")).toHaveCount(0);

  // …and even an explicit reload event for the new session cannot force a
  // frame (this is the exact path that iframed GitHub's 404 on Pages).
  const newSessionId = await page
    .getByTestId("session-context")
    .getAttribute("data-session-id");
  expect(newSessionId).not.toBe("sess-boot");
  await page.evaluate((id) => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: id,
    });
  }, newSessionId);
  await page.waitForTimeout(300);
  await expect(page.locator(".canvas-iframe")).toHaveCount(0);
  await expect(page.locator(".canvas-empty")).toContainText(
    "Nothing generated yet",
  );
  expect(Array.from(sessionsFetched).every((id) => id === "sess-boot")).toBe(
    true,
  );
});

test.describe("background-task canvas states", () => {
  const baseTask = {
    id: "task-1",
    macroId: "visualize",
    label: "Visualize",
    harnessSessionId: "sess-boot",
    cwd: "/Users/demo/acme-app",
    // The mock boot session's bound workflow (MOCK_WORKFLOWS "leasing") —
    // enrichment tasks always carry the workflow they target.
    workflowPath: "/Users/demo/acme-app/leasing" as string | null,
    startedAt: new Date().toISOString(),
    endedAt: null as string | null,
    exitCode: null as number | null,
    statusLines: [] as string[],
    resultText: null as string | null,
    errorTail: null as string | null,
  };

  const publish = (
    page: import("@playwright/test").Page,
    task: unknown,
  ): Promise<void> =>
    page.evaluate((t) => {
      (
        window as unknown as {
          __HARNESS_TEST__: { publish: (message: unknown) => void };
        }
      ).__HARNESS_TEST__.publish({
        type: "task.status",
        task: t,
      });
    }, task);

  test("a running task shows the live activity state, streaming status lines as they arrive", async ({
    page,
  }) => {
    await publish(page, { ...baseTask, status: "running" });

    const activity = page.getByTestId("canvas-task-activity");
    await expect(activity).toBeVisible();
    await expect(activity).toContainText("Visualize is running");
    await expect(activity.locator(".canvas-task-icon")).toBeVisible();

    await publish(page, {
      ...baseTask,
      status: "running",
      statusLines: ["Agent started", "Read steps/route.ts"],
    });
    await expect(page.getByTestId("canvas-task-lines")).toContainText(
      "Read steps/route.ts",
    );

    await page.screenshot({
      path: "web/e2e/screenshots/canvas-task-activity.png",
    });

    // Completion clears the activity state; a canvas.reload for the written
    // index.html (the real server fires one via the canvas watcher) swaps in
    // the generated iframe.
    await publish(page, {
      ...baseTask,
      status: "completed",
      endedAt: new Date().toISOString(),
      exitCode: 0,
    });
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);
    await page.evaluate(() => {
      (
        window as unknown as {
          __HARNESS_TEST__: { publish: (message: unknown) => void };
        }
      ).__HARNESS_TEST__.publish({
        type: "canvas.reload",
        harnessSessionId: "sess-boot",
      });
    });
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  });

  test("activity only shows on the pane of the session that triggered the task", async ({
    page,
  }) => {
    await publish(page, {
      ...baseTask,
      harnessSessionId: "sess-bg",
      status: "running",
    });
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);
    // sess-boot's own pane still shows its ordinary board (its bound agent
    // renders on first paint), not another session's activity.
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  });

  test("activity is scoped to the BOUND WORKFLOW — another workflow's task never bleeds into this pane", async ({
    page,
  }) => {
    // Same session, but the task targets a workflow that is NOT the pane's
    // current binding (sess-boot is bound to leasing) — hidden.
    await publish(page, {
      ...baseTask,
      workflowPath: "/Users/demo/onboarding-flow",
      status: "running",
    });
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);
    // The pane keeps its ordinary board (leasing renders on first paint); the
    // other workflow's task never bleeds in.
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    // The bound workflow's own task shows, overlaid on the board...
    await publish(page, { ...baseTask, id: "task-2", status: "running" });
    await expect(page.getByTestId("canvas-task-activity")).toBeVisible();

    // ...and switching the subject mid-run (Start chat with rfq) hides it
    // again: the rfq session's pane must not show leasing's enrichment
    // progress.
    await startChatWithRfq(page);
    await expect(page.getByTestId("session-context-title")).toContainText(
      "rfq",
    );
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);
  });

  test("enrichment running after content exists: iframe stays visible with the activity strip overlaid", async ({
    page,
  }) => {
    // Bring up the canvas iframe first — simulates the deterministic render
    // that fires immediately when the user clicks Visualize.
    await page.route("**/canvas/sess-boot/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<html><body>diagram</body></html>",
      });
    });
    await page.evaluate(() => {
      (
        window as unknown as {
          __HARNESS_TEST__: { publish: (message: unknown) => void };
        }
      ).__HARNESS_TEST__.publish({
        type: "canvas.reload",
        harnessSessionId: "sess-boot",
      });
    });
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    // Now the enrichment task starts (LLM annotating the diagram in the
    // background). The iframe must stay in the DOM — the activity strip
    // overlays it, not replaces it.
    await publish(page, { ...baseTask, status: "running" });

    const activity = page.getByTestId("canvas-task-activity");
    await expect(activity).toBeVisible();
    await expect(activity).toContainText("Visualize is running");
    // Headline feature: the iframe is NOT hidden while enrichment runs.
    await expect(page.locator(".canvas-iframe")).toBeVisible();
    // The overlay class is applied so the strip sits on top of the iframe.
    await expect(activity).toHaveClass(/canvas-task-activity--overlay/);

    await page.screenshot({
      path: "web/e2e/screenshots/canvas-enrichment-overlay.png",
    });

    // Status lines stream through normally.
    await publish(page, {
      ...baseTask,
      status: "running",
      statusLines: ["Reading steps/intake.ts"],
    });
    await expect(page.getByTestId("canvas-task-lines")).toContainText(
      "Reading steps/intake.ts",
    );
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    // Task completes: activity strip disappears, iframe stays.
    await publish(page, {
      ...baseTask,
      status: "completed",
      endedAt: new Date().toISOString(),
      exitCode: 0,
    });
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  });

  test("failure view is full-screen (no iframe behind it) — unchanged from before", async ({
    page,
  }) => {
    // Get an iframe up first, then trigger a failure.
    await page.route("**/canvas/sess-boot/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<html><body>diagram</body></html>",
      });
    });
    await page.evaluate(() => {
      (
        window as unknown as {
          __HARNESS_TEST__: { publish: (message: unknown) => void };
        }
      ).__HARNESS_TEST__.publish({
        type: "canvas.reload",
        harnessSessionId: "sess-boot",
      });
    });
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    await publish(page, {
      ...baseTask,
      status: "failed",
      endedAt: new Date().toISOString(),
      exitCode: 1,
      errorTail: "Connection lost",
    });

    // Failure state replaces everything — iframe gone, failure panel shown.
    await expect(page.getByTestId("canvas-task-failed")).toBeVisible();
    await expect(page.locator(".canvas-iframe")).toHaveCount(0);

    await page.screenshot({
      path: "web/e2e/screenshots/canvas-failure-fullscreen.png",
    });
  });

  test("a failed task shows the error tail with retry and dismiss affordances", async ({
    page,
  }) => {
    await publish(page, {
      ...baseTask,
      status: "failed",
      endedAt: new Date().toISOString(),
      exitCode: 1,
      errorTail: "API connection lost",
    });

    const failed = page.getByTestId("canvas-task-failed");
    await expect(failed).toBeVisible();
    await expect(failed).toContainText("Visualize failed");
    await expect(failed).toContainText("API connection lost");
    await page.screenshot({
      path: "web/e2e/screenshots/canvas-task-failed.png",
    });

    // Retry re-fires the same macro (MockApi records it for us to read back)
    // — for an enrichment task that's the visualize force refresh.
    await page.getByTestId("canvas-task-retry").click();
    await page.waitForFunction(
      () =>
        (window as unknown as { __HARNESS_TEST__?: { lastMacroRun?: unknown } })
          .__HARNESS_TEST__?.lastMacroRun,
    );
    const lastRun = await page.evaluate(
      () =>
        (
          window as unknown as {
            __HARNESS_TEST__: { lastMacroRun?: { id: string } };
          }
        ).__HARNESS_TEST__.lastMacroRun,
    );
    expect(lastRun?.id).toBe("visualize");
    // The retry runs in the session already bound to the agent; it must not
    // start a second session for it.
    await expect.poll(() => activeSessionId(page)).toBe("sess-boot");

    // Dismiss hides the failure panel and returns the pane to its usual state
    // (the bound board, which sess-boot renders on first paint).
    await page.getByTestId("canvas-task-dismiss").click();
    await expect(page.getByTestId("canvas-task-failed")).toHaveCount(0);
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  });
});

test.describe("agent action bar (status chip + right-anchored actions)", () => {
  test("deployed workflow: the split Run is primary, the deployed pill links out, and Cloud fires a direct prod run", async ({
    page,
  }) => {
    // Boot session is bound to "leasing", which has a definitionId — the one
    // durable signal the server proves; everything else is a repeatable action.
    const bar = page.getByTestId("session-steps");
    await expect(bar).toBeVisible();

    // Deployed → the unified Run control is filled; the lifecycle pill lives once in the
    // right-pane header (the deployed dashboard link), not in the action bar.
    const run = page.getByTestId("session-step-local");
    await expect(run).toBeEnabled();
    await expect(run).toHaveClass(/session-action-primary/);
    await page.getByTestId("right-tab-canvas").click();
    await expect(page.getByTestId("workflow-dashboard-link")).toContainText(
      "deployed",
    );

    // Actions sit right-anchored, in order split Run → Deploy.
    const runBox = await run.boundingBox();
    const deployBox = await page
      .getByTestId("session-step-deploy")
      .boundingBox();
    expect(deployBox?.x ?? 0).toBeGreaterThan(runBox?.x ?? 0);

    // Explicit Cloud opens the input sheet, then fires the DIRECT prod route.
    // it records lastDirectAction, never lastMacroRun, and carries leasing's
    // definitionId as the runs route wants it (a string).
    await page.getByRole("button", { name: "Choose run target" }).click();
    await page.getByRole("menuitemradio", { name: /Cloud/ }).click();
    await page.getByTestId("run-sheet-submit").click();
    await page.waitForFunction(
      () =>
        (
          window as unknown as {
            __HARNESS_TEST__?: { lastDirectAction?: unknown };
          }
        ).__HARNESS_TEST__?.lastDirectAction,
    );
    const lastDirect = await page.evaluate(
      () =>
        (
          window as unknown as {
            __HARNESS_TEST__: {
              lastDirectAction?: {
                action: string;
                req: { definitionId?: string };
              };
            };
          }
        ).__HARNESS_TEST__.lastDirectAction,
    );
    expect(lastDirect?.action).toBe("run");
    expect(lastDirect?.req?.definitionId).toBe("4821");
  });

  test("undeployed workflow: no deployed pill, Deploy is primary, and Run is gated with the deploy reason", async ({
    page,
  }) => {
    await startChatWithRfq(page);
    await expect(page.getByTestId("session-context-title")).toContainText(
      "rfq",
    );

    // A Draft has no lifecycle pill: the deployed dashboard link is absent, and
    // Deploy is the filled primary CTA instead.
    await page.getByTestId("right-tab-canvas").click();
    await expect(page.getByTestId("workflow-dashboard-link")).toHaveCount(0);
    await expect(page.getByTestId("session-step-deploy")).toHaveClass(
      /session-action-primary/,
    );

    await expect(page.getByTestId("session-step-local")).toBeEnabled();
    await expect(page.getByTestId("session-step-deploy")).toBeEnabled();
    await page.getByRole("button", { name: "Choose run target" }).click();
    const run = page.getByTestId("session-step-run");
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute("title", /Not deployed yet/);

    await page.screenshot({ path: "web/e2e/screenshots/session-steps.png" });
  });

  test("narrow pane: the primary split Run keeps its target label", async ({
    page,
  }) => {
    // 820px squeezes the center pane to its 320px floor — under the bar's
    // 580px container threshold, so secondary labels hide while icons stay.
    await page.setViewportSize({ width: 820, height: 720 });

    const local = page.getByTestId("session-step-local");
    await expect(local).toBeVisible();
    await expect(local.locator(".session-step-label")).toBeVisible();
    await expect(local).toContainText("Run · Local");

    // Icon-only stays accessible: name + tooltip ride the button itself.
    await expect(local).toHaveAttribute("aria-label", /.+/);
    await expect(local).toHaveAttribute("data-tooltip", /.+/);

    await page.screenshot({
      path: "web/e2e/screenshots/session-steps-icon-only.png",
    });

    // At a wide width the session bar clears the 580px threshold and the
    // secondary labels return (the center pane must exceed 580px, so the window
    // needs to be well beyond the 3-pane split's narrow floors).
    await page.setViewportSize({ width: 1800, height: 800 });
    await expect(local.locator(".session-step-label")).toBeVisible();
  });
});

test.describe("account profile row", () => {
  test("opens a menu with real account surfaces; demo mode offers connect", async ({
    page,
  }) => {
    const profile = page.getByTestId("brand-identity");
    await expect(profile).toContainText("Demo workspace");
    await profile.click();

    const menu = page.getByTestId("profile-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("profile-open-dashboard")).toBeVisible();
    await page.evaluate(() => {
      const harnessWindow = window as unknown as {
        __SAP_2332_OPENED_URL__?: string;
        open: typeof window.open;
      };
      harnessWindow.open = ((url?: string | URL) => {
        harnessWindow.__SAP_2332_OPENED_URL__ = String(url ?? "");
        return null;
      }) as typeof window.open;
    });
    await page.getByTestId("profile-open-dashboard").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __SAP_2332_OPENED_URL__?: string })
              .__SAP_2332_OPENED_URL__,
        ),
      )
      .toBe("https://app.sapiom.ai/agents");

    // Reopen after the dashboard action closes the menu.
    await profile.click();
    await expect(menu).toBeVisible();
    // Demo build: the switch item reads as connect and stays actionable.
    await expect(page.getByTestId("profile-switch-account")).toHaveText(
      /Connect Sapiom account/,
    );
    await expect(page.getByTestId("profile-switch-account")).toBeEnabled();

    // Dismisses like every other popover.
    await page.locator(".brand-lockup").click();
    await expect(menu).toHaveCount(0);
  });
});

test.describe("resizable panes", () => {
  test("dragging the rail handle resizes the rail and persists across reload", async ({
    page,
  }) => {
    const handle = page.getByTestId("resize-handle-rail");
    const railBefore = await page.locator(".rail-workflows").boundingBox();
    const handleBox = await handle.boundingBox();
    if (!railBefore || !handleBox) throw new Error("expected bounding boxes");

    const y = handleBox.y + handleBox.height / 2;
    await page.mouse.move(handleBox.x + handleBox.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 80, y, {
      steps: 5,
    });
    await page.mouse.up();

    const railAfter = await page.locator(".rail-workflows").boundingBox();
    expect((railAfter?.width ?? 0) - railBefore.width).toBeGreaterThan(60);

    await page.reload();
    await expect(page.locator(".rail-workflows")).toBeVisible();
    const railReloaded = await page.locator(".rail-workflows").boundingBox();
    expect(
      Math.abs((railReloaded?.width ?? 0) - (railAfter?.width ?? 0)),
    ).toBeLessThan(3);
  });

  test("dragging the canvas handle resizes the canvas pane", async ({
    page,
  }) => {
    const handle = page.getByTestId("resize-handle-canvas");
    const canvasBefore = await page.locator(".canvas-pane").boundingBox();
    const handleBox = await handle.boundingBox();
    if (!canvasBefore || !handleBox) throw new Error("expected bounding boxes");

    const y = handleBox.y + handleBox.height / 2;
    await page.mouse.move(handleBox.x + handleBox.width / 2, y);
    await page.mouse.down();
    // Dragging the canvas handle toward the terminal (left) grows the canvas.
    await page.mouse.move(handleBox.x + handleBox.width / 2 - 80, y, {
      steps: 5,
    });
    await page.mouse.up();

    const canvasAfter = await page.locator(".canvas-pane").boundingBox();
    expect((canvasAfter?.width ?? 0) - canvasBefore.width).toBeGreaterThan(60);
  });

  test("dragging the handle while the Secrets tab is shown resizes from the pane's live width", async ({
    page,
  }) => {
    // The board stays mounted but display:none behind Secrets, so the drag
    // must measure the grid column, not the hidden board — otherwise the
    // pane would snap to zero-plus-drag on the first move.
    await page.getByTestId("right-tab-secrets").click();
    await expect(page.getByTestId("right-panel-secrets")).toBeVisible();
    const pane = page.locator(".right-pane");
    const handle = page.getByTestId("resize-handle-canvas");
    const before = await pane.boundingBox();
    const handleBox = await handle.boundingBox();
    if (!before || !handleBox) throw new Error("expected bounding boxes");

    const y = handleBox.y + handleBox.height / 2;
    await page.mouse.move(handleBox.x + handleBox.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 - 80, y, {
      steps: 5,
    });
    await page.mouse.up();

    const after = await pane.boundingBox();
    const grew = (after?.width ?? 0) - before.width;
    expect(grew).toBeGreaterThan(60);
    expect(grew).toBeLessThan(100);
  });

  test("the canvas pane grows past 720px, stopping only at the terminal's floor, and a wide saved width does not overflow a narrower window", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1800, height: 800 });
    const handle = page.getByTestId("resize-handle-canvas");
    const box = await handle.boundingBox();
    if (!box) throw new Error("expected bounding box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 2000, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    const app = page.locator(".app");
    const terminalWidth =
      (await page.locator(".center-pane").boundingBox())?.width ?? 0;
    const canvasWide =
      (await page.locator(".canvas-pane").boundingBox())?.width ?? 0;
    expect(canvasWide).toBeGreaterThan(720);
    expect(terminalWidth).toBeGreaterThanOrEqual(318); // CANVAS_MIN = 320 is also the terminal's floor
    expect(terminalWidth).toBeLessThan(335);
    // Overdrag past the terminal's floor must not bank invisible excess: the
    // stored width is the rendered width, not the pointer's travel.
    const stored = await page.evaluate(() =>
      (JSON.parse(localStorage.getItem("sapiom-harness-pane-widths") ?? "{}") as { canvas?: number })
        .canvas,
    );
    const renderedPane =
      (await page.locator(".right-pane").boundingBox())?.width ?? 0;
    expect(stored).toBeDefined();
    expect(stored ?? 0).toBeGreaterThanOrEqual(Math.floor(renderedPane) - 1);
    expect(stored ?? 0).toBeLessThanOrEqual(Math.ceil(renderedPane) + 1);

    // The pinned width persists; shrinking the window must clamp the track
    // rather than push the shell into horizontal overflow.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.reload();
    await expect(page.locator(".canvas-pane")).toBeVisible();
    const narrowApp = await app.boundingBox();
    if (!narrowApp) throw new Error("expected bounding box");
    const scrollWidth = await app.evaluate((el) => el.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(Math.ceil(narrowApp.width) + 1);
    const canvasNarrow =
      (await page.locator(".canvas-pane").boundingBox())?.width ?? 0;
    expect(canvasNarrow).toBeLessThan(canvasWide);
    const terminalNarrow =
      (await page.locator(".center-pane").boundingBox())?.width ?? 0;
    expect(terminalNarrow).toBeGreaterThanOrEqual(318);

    // A short drag back right shrinks the pane immediately — the drag starts
    // from the rendered edge, not from the wider stored number.
    const narrowHandle = await handle.boundingBox();
    if (!narrowHandle) throw new Error("expected bounding box");
    await page.mouse.move(
      narrowHandle.x + narrowHandle.width / 2,
      narrowHandle.y + narrowHandle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(narrowHandle.x + 100, narrowHandle.y + narrowHandle.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
    const canvasShrunk =
      (await page.locator(".canvas-pane").boundingBox())?.width ?? 0;
    expect(canvasShrunk).toBeLessThan(canvasNarrow - 60);
  });

  test("rail and canvas widths cannot be dragged past their min-width floors", async ({
    page,
  }) => {
    const railHandle = page.getByTestId("resize-handle-rail");
    let box = await railHandle.boundingBox();
    if (!box) throw new Error("expected bounding box");
    await page.mouse.move(box.x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 1000, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const railWidth =
      (await page.locator(".rail-workflows").boundingBox())?.width ?? 0;
    expect(railWidth).toBeGreaterThanOrEqual(178); // RAIL_MIN = 180, small rounding slack
    expect(railWidth).toBeLessThan(195);

    const canvasHandle = page.getByTestId("resize-handle-canvas");
    box = await canvasHandle.boundingBox();
    if (!box) throw new Error("expected bounding box");
    await page.mouse.move(box.x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 1000, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const canvasWidth =
      (await page.locator(".canvas-pane").boundingBox())?.width ?? 0;
    expect(canvasWidth).toBeGreaterThanOrEqual(318); // CANVAS_MIN = 320 (20rem), small rounding slack
    expect(canvasWidth).toBeLessThan(335);
  });

  test("double-clicking a handle resets it to its default width", async ({
    page,
  }) => {
    const handle = page.getByTestId("resize-handle-rail");
    const box = await handle.boundingBox();
    if (!box) throw new Error("expected bounding box");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, y, { steps: 5 });
    await page.mouse.up();

    await handle.dblclick();
    const railWidth =
      (await page.locator(".rail-workflows").boundingBox())?.width ?? 0;
    expect(Math.abs(railWidth - 320)).toBeLessThan(3); // RAIL_DEFAULT = 320 (20rem)
  });

  test("both panels collapse and expand from dynamically anchored controls", async ({
    page,
  }) => {
    // Rail: collapse from its own header; the expand affordance appears
    // left-anchored in the session bar, before the tabs.
    await page.getByTestId("rail-collapse").click();
    await expect(page.locator(".rail-workflows")).not.toBeVisible();
    const expandRail = page.getByTestId("rail-expand");
    await expect(expandRail).toBeVisible();
    const expandBox = await expandRail.boundingBox();
    const contextBox = await page.getByTestId("session-context").boundingBox();
    expect(expandBox?.x ?? 0).toBeLessThan(contextBox?.x ?? 0);

    await expandRail.click();
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("rail-expand")).toHaveCount(0);

    // Right pane: collapse from its tabs bar; kept ATTACHED (canvas
    // keep-alive) but hidden; the expand affordance is the session bar's
    // last control on the right.
    await page.getByTestId("right-collapse").click();
    await expect(page.getByTestId("right-panel-canvas")).toBeAttached();
    await expect(page.getByTestId("right-panel-canvas")).not.toBeVisible();
    const expandRight = page.getByTestId("right-expand");
    await expect(expandRight).toBeVisible();
    const rightBox = await expandRight.boundingBox();
    const contextBox2 = await page.getByTestId("session-context").boundingBox();
    expect(rightBox?.x ?? 0).toBeGreaterThan(contextBox2?.x ?? 0);

    await expandRight.click();
    await expect(page.getByTestId("right-panel-canvas")).toBeVisible();
    await expect(page.getByTestId("right-expand")).toHaveCount(0);
  });

  test("terminal and canvas split the main area equally by default", async ({
    page,
  }) => {
    const center = await page.locator(".center-pane").boundingBox();
    const canvas = await page.locator(".canvas-pane").boundingBox();
    expect(center).not.toBeNull();
    expect(canvas).not.toBeNull();
    // Fresh state (no stored drag) = 1fr/1fr — equal within rounding slack.
    expect(Math.abs((center?.width ?? 0) - (canvas?.width ?? 0))).toBeLessThan(
      25,
    );

    // Dragging then double-clicking the canvas handle returns to the split.
    const handle = page.getByTestId("resize-handle-canvas");
    const box = await handle.boundingBox();
    if (!box) throw new Error("expected bounding box");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, y, { steps: 5 });
    await page.mouse.up();
    await handle.dblclick();

    const centerAfter = await page.locator(".center-pane").boundingBox();
    const canvasAfter = await page.locator(".canvas-pane").boundingBox();
    expect(
      Math.abs((centerAfter?.width ?? 0) - (canvasAfter?.width ?? 0)),
    ).toBeLessThan(25);
  });
});

test.describe("canvas iframe theme", () => {
  // Pin the OS to dark to prove the light product default still reaches the
  // iframe; the test then proves that a manual toggle reaches it too.
  test.use({ colorScheme: "dark" });

  test("the canvas iframe carries the app's theme and flips on toggle", async ({
    page,
  }) => {
    await page.evaluate(() => {
      (
        window as unknown as {
          __HARNESS_TEST__: { publish: (message: unknown) => void };
        }
      ).__HARNESS_TEST__.publish({
        type: "canvas.reload",
        harnessSessionId: "sess-boot",
      });
    });

    const iframe = page.locator(".canvas-iframe");
    await expect(iframe).toHaveAttribute("src", /theme=light/);

    await toggleTheme(page);
    await expect(iframe).toHaveAttribute("src", /theme=dark/);
  });
});

test("end session: the header ⋯ menu opens a confirm dialog before ending the session", async ({
  page,
}) => {
  // sess-boot is selected — end it from the header menu.
  const header = page.getByTestId("session-context");
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");

  // The menu item never kills directly — it opens a proper confirm dialog.
  await page.getByTestId("session-menu").click();
  await page.getByTestId("session-end-btn").click();
  const confirm = page.getByTestId("end-session-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("kills the live terminal");

  // Keep cancels — nothing dies.
  await page.getByRole("button", { name: "Keep session" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");

  // Confirming ends the session; it stays selected, as ended (D43), rather
  // than jumping the centre to another session.
  await page.getByTestId("session-menu").click();
  await page.getByTestId("session-end-btn").click();
  await page.getByTestId("end-session-confirm-btn").click();
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");
});

test.describe("session menu copy path", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("Copy path confirms with the same toast as the rail's copy action", async ({
    page,
  }) => {
    // A4-05: the ⋯ menu's Copy path used to write silently — same verb as
    // the rail's copy action, so it confirms (or fails) with the same toast.
    await page.getByTestId("session-menu").click();
    await page.getByRole("menuitem", { name: "Copy path" }).click();
    await expect(page.getByTestId("toast")).toContainText("Path copied.");
  });
});

test("folder field: Enter fires the dialog's primary action", async ({
  page,
}) => {
  // The in-app listing's arrow-key navigation went with the listing; Enter is
  // no longer "drill into the highlighted row", it is "do the one thing this
  // dialog is for": add the folder as a project.
  await page.getByTestId("rail-add-project").click();
  const input = page.getByTestId("folder-field-input");
  await input.fill("/Users/demo/rfq-agent");
  await expect(page.getByTestId("project-folder-continue")).toBeEnabled();

  await input.press("Enter");
  await expect(page.getByTestId("project-folder-dialog")).toBeHidden();
  // The folder is a project header in the rail.
  await expect(page.getByTestId("workspace-group-rfq-agent")).toBeVisible();
});

test("canvas controls: the board widget zooms; the subheader's expand lifts the pane to an overlay", async ({
  page,
}) => {
  // Swap the empty state for the demo iframe first (same bus message the
  // agent's canvas.reload event sends).
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (m: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  const iframe = page.locator(".canvas-iframe");
  await expect(iframe).toBeVisible();

  const controls = page.getByTestId("canvas-view-controls");
  await expect(controls).toBeVisible();

  // The demo document posts its natural size and the app auto-fits on
  // first render: at this viewport the cascade is taller than the
  // visible board, so the fitted rest zoom lands below 100% with the whole
  // graph clear of the docked controls. The Fit button is disabled at rest.
  const fit = page.getByTestId("canvas-fit");
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");
  const fittedZoom = await page.getByTestId("canvas-zoom-reset").textContent();
  await expect(fit).toBeDisabled();

  // View contract: the iframe element never transforms (the board always
  // fills the pane); the view state is posted into the document, whose GRAPH
  // pans/scales over the anchored dotted surface.
  const graph = page.frameLocator(".canvas-iframe").locator(".cascade");
  await page.getByTestId("canvas-zoom-reset").click();
  await expect(page.getByTestId("canvas-zoom-reset")).toHaveText("100%");
  await expect(iframe).toHaveCSS("transform", "none");
  await expect(graph).toHaveCSS("transform", "none");
  await page.getByTestId("canvas-zoom-in").click();
  await expect(page.getByTestId("canvas-zoom-reset")).toHaveText("125%");
  await expect(graph).toHaveCSS("transform", /matrix\(1\.25/);

  // Fit-to-view sits at the right end of the widget; it armed as soon as
  // the view left the fitted rest pose, and one click returns there.
  const fitBox = await fit.boundingBox();
  const zoomInBox = await page.getByTestId("canvas-zoom-in").boundingBox();
  expect(fitBox?.x ?? 0).toBeGreaterThan(zoomInBox?.x ?? 0);
  await expect(fit).toBeEnabled();
  await fit.click();
  await expect(page.getByTestId("canvas-zoom-reset")).toHaveText(
    fittedZoom ?? "100%",
  );
  await expect(fit).toBeDisabled();

  // The gesture surface for drag-pan/wheel-zoom covers the board.
  await expect(page.getByTestId("canvas-pan-layer")).toBeVisible();

  // The board widget carries zoom only — the panel-level expand lives in the
  // right-pane tab bar, right beside the collapse-panel toggle.
  await expect(controls.getByTestId("canvas-expand")).toHaveCount(0);
  const expand = page.getByTestId("canvas-expand");

  // Expand: same node, fixed overlay — the iframe is not remounted. The
  // overlay covers the subheader, so it carries its own exit control.
  await expand.click();
  await expect(page.locator(".canvas-frame-wrap")).toHaveClass(/is-expanded/);
  await expect(page.locator(".canvas-frame-wrap")).toHaveCSS(
    "position",
    "fixed",
  );
  await expect(page.getByTestId("resize-handle-rail")).toHaveCount(0);
  await expect(page.getByTestId("resize-handle-canvas")).toHaveCount(0);
  await page.getByTestId("canvas-expand-exit").click();
  await expect(page.locator(".canvas-frame-wrap")).not.toHaveClass(
    /is-expanded/,
  );
  await expect(page.getByTestId("resize-handle-rail")).toBeVisible();
  await expect(page.getByTestId("resize-handle-canvas")).toBeVisible();

  // Escape works too.
  await expand.click();
  await expect(page.locator(".canvas-frame-wrap")).toHaveClass(/is-expanded/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".canvas-frame-wrap")).not.toHaveClass(
    /is-expanded/,
  );
});

test("steps tab drills into a step's real transitions and slides back", async ({
  page,
}) => {
  // The demo document posts its real graph ({type:"sapiom-canvas:graph"});
  // load it via the same reload event the agent fires.
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (m: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  const frame = page.locator(".canvas-frame-wrap");
  await expect(frame).toHaveAttribute("data-view", "board");

  // Steps is a first-class right-pane tab, a projection of the same posted
  // graph; the subheader names the workflow and the REAL step count.
  await page.getByTestId("right-tab-steps").click();
  await expect(frame).toHaveAttribute("data-view", "steps");
  // One counting rule everywhere (graphCounts): pipeline steps exclude the
  // two terminal exits, which are named separately.
  await expect(page.getByTestId("canvas-steps-count")).toHaveText(
    "4 steps · 2 exits",
  );

  // The step list is built from the posted graph, not guessed.
  await expect(page.getByTestId("canvas-steps-list")).toBeVisible();
  const approveRow = page.getByTestId("canvas-step-row-approve");
  await expect(approveRow).toBeVisible();

  // Row anatomy carries manifest truth: zero-padded index, name + role copy,
  // and structural facts (input contract size, branch fan-out, timeout).
  await expect(approveRow).toContainText("04");
  await expect(approveRow).toContainText("1 input · 2 branches");
  await expect(page.getByTestId("canvas-step-row-credit-check")).toContainText(
    "30s limit",
  );
  // Grouped steps sit under their board band's label.
  await expect(page.getByTestId("canvas-steps-list")).toContainText(
    "intake & screening",
  );

  // Rows are an ACCORDION: clicking one expands its FULL detail INLINE — a
  // dropdown, NOT a separate slide-in view (data-view stays "steps").
  await approveRow.click();
  const expand = page.getByTestId("canvas-step-expand-approve");
  await expect(expand).toBeVisible();
  await expect(frame).toHaveAttribute("data-view", "steps");

  const detail = page.getByTestId("canvas-step-detail");
  await expect(detail).toBeVisible();

  // Real outgoing transitions with their branch conditions, both terminals.
  await expect(detail).toContainText("draft-lease");
  await expect(detail).toContainText("score ≥ 620");
  await expect(detail).toContainText("manual-review");
  await expect(detail).toContainText("declined");

  // The Contract section renders the step's REAL declared input schema and the
  // capabilities it calls.
  const contract = detail.getByTestId("canvas-detail-input");
  await expect(contract).toContainText("score");
  await expect(contract).toContainText("number");
  await expect(detail.getByTestId("canvas-detail-capabilities")).toContainText(
    "rules.evaluate",
  );

  // Per-step coding-agent actions live in the dropdown (ported from the retired
  // detail-pane header): "Ask coding agent" sends a step-scoped prompt (never a
  // workflow-scoped one), and "Ask to modify" sends the modify prompt.
  const askCodingAgent = detail.getByTestId("canvas-detail-ask");
  await expect(askCodingAgent).toBeVisible();
  await expect(askCodingAgent).toContainText("Ask coding agent");
  await askCodingAgent.click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __HARNESS_TEST__?: {
                lastInjectInput?: { req: { text: string } };
              };
            }
          ).__HARNESS_TEST__?.lastInjectInput?.req.text ?? "",
      ),
    )
    .toContain("step of this agent");
  const askPrompt = await page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { lastInjectInput?: { req: { text: string } } };
        }
      ).__HARNESS_TEST__?.lastInjectInput?.req.text ?? "",
  );
  expect(askPrompt.toLowerCase()).not.toContain("workflow");

  await page.evaluate(() => {
    const hook = (
      window as unknown as { __HARNESS_TEST__?: Record<string, unknown> }
    ).__HARNESS_TEST__;
    if (hook) delete hook.lastInjectInput;
  });
  await detail.getByTestId("canvas-detail-modify").click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __HARNESS_TEST__?: {
                lastInjectInput?: { req: { text: string } };
              };
            }
          ).__HARNESS_TEST__?.lastInjectInput?.req.text ?? "",
      ),
    )
    .toContain("step of this agent");

  await page.screenshot({ path: "web/e2e/screenshots/canvas-step-detail.png" });

  // Collapsing the row hides the detail again; the list stays put.
  await approveRow.click();
  await expect(page.getByTestId("canvas-step-detail")).toHaveCount(0);
  await expect(frame).toHaveAttribute("data-view", "steps");
  await page.getByTestId("right-tab-canvas").click();
  await expect(frame).toHaveAttribute("data-view", "board");
});

test("canvas repair sends the coding agent an Agent-terminology prompt", async ({
  page,
}) => {
  const canvasBody = page.frameLocator(".canvas-iframe").locator("body");
  await expect(canvasBody).toBeVisible();
  // POST UNTIL IT LANDS. The board is an srcdoc iframe the shell re-renders, so
  // a single postMessage can be aimed at a document that is replaced before it
  // is delivered — the message is simply lost and the assertion below then
  // blames the error pane. Visible-then-evaluate is not a guarantee that the
  // document surviving the evaluate is the one the shell is listening to.
  // Re-posting is safe: the handler renders the same error state each time.
  await expect
    .poll(
      async () => {
        await canvasBody
          .evaluate(() => {
            window.parent.postMessage(
              {
                type: "sapiom-canvas:error",
                title: "leasing",
                reason: "TypeScript extraction failed",
              },
              "*",
            );
          })
          .catch(() => {});
        return page
          .getByTestId("canvas-render-error")
          .isVisible()
          .catch(() => false);
      },
      { timeout: 10_000, intervals: [100, 200, 300, 500] },
    )
    .toBe(true);
  await expect(page.getByTestId("canvas-render-error")).toBeVisible();
  await page.getByTestId("canvas-error-fix").click();

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __HARNESS_TEST__?: {
                lastInjectInput?: { req: { text: string } };
              };
            }
          ).__HARNESS_TEST__?.lastInjectInput?.req.text ?? "",
      ),
    )
    .toContain("agent graph extracts cleanly");
  const prompt = await page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { lastInjectInput?: { req: { text: string } } };
        }
      ).__HARNESS_TEST__?.lastInjectInput?.req.text ?? "",
  );
  expect(prompt.toLowerCase()).not.toContain("workflow");
});

test("a detected dev server surfaces a Preview chip on the action bar", async ({
  page,
}) => {
  await expect(page.getByTestId("session-preview-chip")).toHaveCount(0);
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (m: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "port.detected",
      harnessSessionId: "sess-boot",
      port: 5173,
      url: "http://localhost:5173/",
    });
  });
  const chip = page.getByTestId("session-preview-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Preview :5173");
  await expect(chip).toHaveAttribute("href", "http://localhost:5173/");
  await expect(chip).toHaveAttribute(
    "data-tooltip",
    "The coding agent is serving an app on port 5173. Opens http://localhost:5173/",
  );
});

test("an observed run renders per-step status and latency in the steps tab", async ({
  page,
}) => {
  // Load the demo document's graph first and WAIT for the board: lastMessage
  // is a single slot, so back-to-back publishes in one tick would drop the
  // reload. Then announce the run the way the server's ExecutionDetector does.
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (m: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute(
    "data-view",
    "board",
  );
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (m: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-demo-1",
      target: "prod",
    });
  });
  await page.getByTestId("right-tab-steps").click();

  // Run truth appears as chronological attempts with status + timing.
  const introRow = page.getByRole("option", { name: /intake/ });
  await expect(introRow.locator(".run-timeline-status")).toHaveAttribute(
    "aria-label",
    "passed",
  );
  await expect(introRow).toContainText("240ms");
  await expect(
    page.getByRole("option", { name: /credit-check/ }),
  ).toContainText("1.9s");
  // The chip and compact header carry status and Cloud target.
  await expect(page.getByTestId("canvas-run-chip")).toContainText(
    "prod run completed",
  );
  await expect(page.locator(".run-workspace-header")).toContainText("Cloud");

  // Detail carries the same run truth in the shared attempt inspector.
  await introRow.click();
  const runSection = page.getByRole("region", { name: "intake attempt 1" });
  await expect(runSection).toContainText("passed");
  await expect(runSection).toContainText("240ms");
});

test("an observed run renders its real steps even before anything is visualized", async ({
  page,
}) => {
  // The second leasing session ships no bundled doc, so nothing is visualized
  // for it (no graph). A run announcement alone must still surface real
  // per-step truth in the Steps tab instead of "No steps yet". (The boot
  // session opens on its board, which already posts a graph — the fallback is
  // exactly this no-graph path.)
  await selectSession(page, "sess-leasing-2");
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (m: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "execution.started",
      harnessSessionId: "sess-leasing-2",
      executionId: "exec-local-1",
      target: "local",
    });
  });
  await page.getByTestId("right-tab-steps").click();
  const workspace = page.getByTestId("run-workspace");
  await expect(workspace).toBeVisible();
  await expect(page.getByRole("option", { name: /intake/ })).toContainText(
    "240ms",
  );
  await expect(
    page.getByRole("option", { name: /credit-check/ }),
  ).toContainText("1.9s");
  // The server declared this run local: the compact header carries the target. The
  // Studio is cost-free, so no money renders anywhere on the run surface.
  await expect(page.locator(".run-workspace-header")).toContainText("Local");
  await expect(workspace).not.toContainText("$");
});

test("a second run never erases the first: the run picker recalls past runs", async ({
  page,
}) => {
  const publishRun = (executionId: string): Promise<void> =>
    page.evaluate((id) => {
      (
        window as unknown as {
          __HARNESS_TEST__: { publish: (m: unknown) => void };
        }
      ).__HARNESS_TEST__.publish({
        type: "execution.started",
        harnessSessionId: "sess-boot",
        executionId: id,
        target: "prod",
      });
    }, executionId);

  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (m: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute(
    "data-view",
    "board",
  );
  await publishRun("exec-demo-1");
  // Second run: the first run's record survives the new execution.
  await publishRun("exec-demo-2");

  // The run chip becomes a picker with two observed runs: any past run is
  // one click away, refetched through the same run-state endpoint.
  await page.getByTestId("right-tab-steps").click();
  const chip = page.getByTestId("canvas-run-chip");
  await expect(chip).toContainText("prod run completed");
  await chip.click();
  const menu = page.getByTestId("canvas-run-menu");
  await expect(menu.getByTestId("canvas-run-option-exec-demo-1")).toContainText(
    "run 1 · completed · prod",
  );
  await expect(menu.getByTestId("canvas-run-option-exec-demo-2")).toContainText(
    "run 2 · completed · prod",
  );
  await menu.getByTestId("canvas-run-option-exec-demo-1").click();
  await expect(menu).toHaveCount(0);
  await chip.click();
  await expect(
    page.getByTestId("canvas-run-option-exec-demo-1"),
  ).toHaveAttribute("aria-checked", "true");
});

test("board nodes get hover and selected states through the message contract", async ({
  page,
}) => {
  // Between the extremes: the refit assertions below need both fitted zooms
  // (overview open and collapsed) off the widget's 50% floor AND below the
  // 100% cap, so a zoom CHANGE is observable. With the Canvas tab back to a
  // pure board (the snippets moved to the Code tab) the board is taller, so
  // 1000px would fit at the 100% cap; 820 keeps both zooms in between.
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (m: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  const boardFrame = page.frameLocator(".canvas-frame-wrap iframe");
  // The intake node sits at the top of the cascade, safely above the
  // overview sheet that overlays the lower board.
  const intakeNode = boardFrame.locator('[data-node-id="intake"]');
  await expect(intakeNode).toBeVisible();
  // Auto-fit lands right after the document posts its size — wait for the
  // view to settle so measured node positions can't shift mid-test.
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");

  // The gesture layer covers the iframe, so hover must travel as a message:
  // pointer over the node -> document applies .is-hover and answers with a
  // hit -> the layer flips its cursor affordance.
  const box = await intakeNode.boundingBox();
  if (!box) throw new Error("intake node has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 3,
  });
  await expect(intakeNode).toHaveClass(/is-hover/);
  await expect(page.getByTestId("canvas-pan-layer")).toHaveAttribute(
    "data-over-node",
    "true",
  );

  // A non-drag click on a node is a PICK: the bottom inspector populates in
  // place (no tab switch — the Steps tab is its explicit "Open step"
  // drill), and the board rings the selected node. Collapse the overview
  // sheet first so it can't overlay the lower nodes — the taller board
  // refits (larger zoom), so wait for that view to settle too.
  const zoomBeforeCollapse = await page
    .getByTestId("canvas-zoom-reset")
    .textContent();
  await page.getByTestId("canvas-overview-toggle").click();
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText(
    zoomBeforeCollapse ?? "",
  );
  const approveNode = boardFrame.locator('[data-node-id="approve"]');
  const approveBox = await approveNode.boundingBox();
  if (!approveBox) throw new Error("approve node has no box");
  await page.mouse.click(
    approveBox.x + approveBox.width / 2,
    approveBox.y + approveBox.height / 2,
  );
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute(
    "data-view",
    "board",
  );
  await expect(page.getByTestId("right-tab-canvas")).toHaveClass(/is-active/);
  await expect(page.getByTestId("canvas-inspector-title")).toHaveText(
    "approve?",
  );
  await expect(approveNode).toHaveClass(/is-selected/);
  await page.getByTestId("canvas-inspector-close").click();
  await expect(approveNode).not.toHaveClass(/is-selected/);
});
