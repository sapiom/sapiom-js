/**
 * The project's Agent Map as the map tool computes it (plans/agent-map-rebuild
 * design: systems as containers, a ref selector, refresh). The mock serves
 * acme-app a three-agent system (leasing, screening, applicant-notifier), one
 * loose agent (rent-reminder), two code-proven calls, a shared vault key on
 * leasing and screening, and a git repository with two branches; any other mock
 * project draws its agents loose, outside git. The ref selector and refresh sit
 * in the project bar (SessionBar), not in the map pane.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const BASE = "/?seed=0&mockFixtures=deep&mockStudioProjects=present";
const SYSTEM = "map-system-sys-mock-leasing";
const IN_SYSTEM = ["leasing", "screening", "applicant-notifier"] as const;
const LAUNCH = "agent-map-edge-leasing--screening--launch";
const EVENT =
  "agent-map-edge-screening--applicant-notifier--event--screening.completed";

type TestWindow = Window & {
  __HARNESS_TEST__: {
    publish: (message: unknown) => void;
    projectMapCalls?: Array<{ projectId: string; ref: string | null }>;
  };
};

async function select(page: Page, project: string, query: string) {
  await page.goto(BASE + query);
  await page.getByTestId(`project-select-${project}`).click();
}

async function openReady(page: Page, project = "acme-app", query = "") {
  await select(page, project, query);
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
    "data-layout-state",
    "ready",
  );
}

const calls = (page: Page) =>
  page.evaluate(
    () => (window as TestWindow).__HARNESS_TEST__.projectMapCalls ?? [],
  );
const callCount = async (page: Page) => (await calls(page)).length;
const node = (page: Page, slug: string): Locator =>
  page.getByTestId(`agent-map-node-${slug}`);

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found!;
}

const inside = (
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number },
) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/** Choose a ref from the project bar's menu: "working", "HEAD" or a branch. */
async function chooseRef(page: Page, id: string) {
  const trigger = page.getByTestId("project-map-ref");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.getByTestId(`project-map-ref-${id}`).click();
  await expect(page.getByTestId("project-map-ref-menu")).toHaveCount(0);
}

async function publishMapChanged(page: Page, projectId: string, times = 1) {
  await page.evaluate(
    ({ projectId, times }) => {
      const publish = (window as TestWindow).__HARNESS_TEST__.publish;
      for (let i = 0; i < times; i++)
        publish({ type: "project-map.changed", projectId });
    },
    { projectId, times },
  );
}

test.describe("systems as containers", () => {
  test("the system holds exactly its three agents and the loose agent sits outside every system", async ({
    page,
  }) => {
    await openReady(page);
    await expect(page.locator("[data-system-id]")).toHaveCount(1);
    await expect(page.getByTestId(SYSTEM)).toHaveAttribute("data-group", "leasing");
    const pill = page.getByTestId(SYSTEM).locator(".agent-map-system-name");
    await expect(pill).toContainText("leasing");
    await expect(pill).toContainText("3 agents");
    const system = await box(page.getByTestId(SYSTEM));
    for (const slug of IN_SYSTEM)
      expect(inside(system, await box(node(page, slug))), slug).toBe(true);
    const loose = await box(node(page, "rent-reminder"));
    expect(inside(system, loose)).toBe(false);
    expect(overlaps(system, loose)).toBe(false);
    await expect(page.locator(".agent-map-node")).toHaveCount(4);
  });

  test("Deployed and Draft badges follow the fixture, and chips sit on leasing and screening only", async ({
    page,
  }) => {
    await openReady(page);
    const badge = (slug: string) => node(page, slug).locator(".agent-map-deployment");
    await expect(badge("leasing")).toHaveText("Deployed");
    await expect(node(page, "leasing")).toHaveAttribute("data-deployment-state", "deployed");
    await expect(node(page, "leasing")).toHaveAttribute("data-deploy-state", "Deployed");
    await expect(node(page, "leasing")).toHaveAttribute("data-node-id", "leasing");
    await expect(badge("screening")).toHaveText("Draft");
    await expect(node(page, "screening")).toHaveAttribute("data-deployment-state", "draft");
    await expect(node(page, "screening")).toHaveAttribute("data-deploy-state", "Draft");
    await expect(badge("applicant-notifier")).toHaveText("Deployed");
    await expect(badge("rent-reminder")).toHaveCount(0);
    await expect(node(page, "rent-reminder")).not.toHaveAttribute("data-deployment-state", /.*/);
    await expect(node(page, "rent-reminder")).not.toHaveAttribute("data-deploy-state", /.*/);

    for (const slug of ["leasing", "screening"]) {
      const chip = page.getByTestId(`map-chip-${slug}-APPLICANT_DB_URL`);
      await expect(chip).toHaveText("APPLICANT_DB_URL");
      await expect(chip).toHaveAttribute("data-chip-kind", "vault");
      await expect(node(page, slug).locator(`[data-testid^="map-chip-"]`)).toHaveCount(1);
    }
    for (const slug of ["applicant-notifier", "rent-reminder"])
      await expect(node(page, slug).locator(`[data-testid^="map-chip-"]`)).toHaveCount(0);
    await expect(page.locator('[data-testid^="map-chip-"]')).toHaveCount(2);
  });

  test("chips that do not fit fold into +N, the first always shows, and the title lists the rest", async ({
    page,
  }) => {
    await openReady(page, "acme-app", "&mockProjectMapChips=many");
    await expect(page.getByTestId("map-chip-leasing-APPLICANT_DB_URL")).toBeVisible();
    const more = page.getByTestId("map-chip-leasing-more");
    await expect(more).toHaveText("+3");
    await expect(more).toHaveAttribute(
      "title",
      "LEASES_DB, SLACK_WORKSPACE, STRIPE_SECRET_KEY",
    );
    await expect(page.getByTestId("map-chip-leasing-LEASES_DB")).toHaveCount(0);
    await expect(page.locator('[data-testid^="map-chip-leasing-"]')).toHaveCount(2);
    // screening still has its one chip and no fold.
    await expect(page.getByTestId("map-chip-screening-more")).toHaveCount(0);
  });

  test("the two code-proven calls are edges and draw no label text", async ({
    page,
  }) => {
    await openReady(page);
    await expect(page.locator('[data-testid^="agent-map-edge-"]')).toHaveCount(2);
    await expect(page.getByTestId(LAUNCH)).toHaveAttribute("data-edge-kind", "launch");
    await expect(page.getByTestId(EVENT)).toHaveAttribute("data-edge-kind", "event");
    await expect(page.locator(".agent-map-edge-label")).toHaveCount(0);
    await expect(page.locator('[data-testid^="agent-map-edge-"] text')).toHaveCount(0);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`the system container has a visible border in ${theme} mode`, async ({ page }) => {
      await openReady(page);
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const style = await page.getByTestId(SYSTEM).evaluate((element) => {
        const own = getComputedStyle(element);
        // The board is the first opaque background up from the viewport.
        let board = element.closest(".agent-map-viewport") as Element | null;
        while (board) {
          const color = getComputedStyle(board).backgroundColor;
          if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") break;
          board = board.parentElement;
        }
        return {
          width: own.borderTopWidth,
          line: own.borderTopStyle,
          color: own.borderTopColor,
          board: board ? getComputedStyle(board).backgroundColor : null,
        };
      });
      expect(style.width).toBe("1px");
      expect(style.line).toBe("solid");
      expect(style.board).not.toBeNull();
      expect(style.color).not.toBe(style.board);
      await expect(page.getByTestId(SYSTEM)).toBeVisible();
    });
  }
});

test.describe("project bar and pane header", () => {
  test("the pane header names the project and counts its agents; the bar carries the ref menu and refresh", async ({
    page,
  }) => {
    await openReady(page);
    await expect(page.getByTestId("agent-map-project-name")).toHaveText("acme-app");
    await expect(page.getByTestId("agent-map-count")).toHaveText("4 agents");
    // Controls live in the project bar, not in the pane.
    await expect(page.getByTestId("session-context").getByTestId("project-map-ref")).toBeVisible();
    await expect(page.getByTestId("session-context").getByTestId("project-map-refresh")).toBeEnabled();
    await expect(page.getByTestId("agent-map-live").getByTestId("project-map-ref")).toHaveCount(0);

    const trigger = page.getByTestId("project-map-ref");
    await expect(trigger).toHaveAttribute("data-ref", "working");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toContainText("Working copy");
    await expect(page.getByTestId("project-map-ref-menu")).toHaveCount(0);
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByTestId("project-map-ref-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemradio")).toHaveCount(4);
    await expect(page.getByTestId("project-map-ref-working")).toHaveText("Working copy");
    await expect(page.getByTestId("project-map-ref-working")).toHaveAttribute("aria-checked", "true");
    // HEAD names its branch on a second line.
    await expect(page.getByTestId("project-map-ref-HEAD")).toContainText("HEAD");
    await expect(page.getByTestId("project-map-ref-HEAD")).toContainText("main");
    await expect(page.getByTestId("project-map-ref-HEAD")).toHaveAttribute("aria-checked", "false");
    await expect(menu).toContainText("Branches");
    await expect(page.getByTestId("project-map-ref-feature/screening")).toHaveText("feature/screening");
    await expect(page.getByTestId("project-map-ref-main")).toHaveText("main");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("screening is changed against HEAD at Working copy; no other agent is", async ({ page }) => {
    await openReady(page);
    const dot = page.getByTestId("map-node-changed-screening");
    await expect(dot).toHaveAttribute("aria-label", "Changed since HEAD");
    await expect(node(page, "screening")).toHaveAttribute("data-changed", "true");
    await expect(page.locator('[data-testid^="map-node-changed-"]')).toHaveCount(1);
    for (const slug of ["leasing", "applicant-notifier", "rent-reminder"])
      await expect(node(page, slug)).not.toHaveAttribute("data-changed", /.*/);
  });

  test("choosing a branch re-reads at that ref and relabels the changed dot; Working copy goes back", async ({
    page,
  }) => {
    await openReady(page);
    expect(await calls(page)).toEqual([
      { projectId: expect.any(String), ref: null },
    ]);
    await chooseRef(page, "feature/screening");
    await expect(page.getByTestId("agent-map-live")).toHaveAttribute(
      "data-ref",
      "feature/screening",
    );
    const trigger = page.getByTestId("project-map-ref");
    await expect(trigger).toHaveAttribute("data-ref", "feature/screening");
    await expect(trigger).toContainText("feature/screening");
    await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
      "data-layout-state",
      "ready",
    );
    // The old map stays while the new read is in flight, so wait for the read.
    await expect.poll(async () => (await calls(page)).at(-1)).toMatchObject({
      ref: "feature/screening",
    });
    await expect(page.getByTestId("map-node-changed-screening")).toHaveAttribute(
      "aria-label",
      "Changed since feature/screening",
    );
    await expect(page.locator('[data-testid^="map-node-changed-"]')).toHaveCount(1);
    await expect(node(page, "screening")).toHaveAttribute("data-changed", "true");
    for (const slug of ["leasing", "applicant-notifier", "rent-reminder"])
      await expect(node(page, slug)).not.toHaveAttribute("data-changed", /.*/);

    await trigger.click();
    await expect(page.getByTestId("project-map-ref-feature/screening")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("project-map-ref-working")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.getByTestId("project-map-ref-working").click();
    await expect(trigger).toHaveAttribute("data-ref", "working");
    await expect(page.getByTestId("agent-map-live")).not.toHaveAttribute("data-ref", /.*/);
    await expect(page.getByTestId("map-node-changed-screening")).toHaveAttribute(
      "aria-label",
      "Changed since HEAD",
    );
    await expect.poll(async () => (await calls(page)).at(-1)).toMatchObject({ ref: null });
  });

  test("the chosen ref is the project's: it survives leaving the project and coming back", async ({
    page,
  }) => {
    await openReady(page);
    await chooseRef(page, "feature/screening");
    await expect(page.getByTestId("agent-map-live")).toHaveAttribute(
      "data-ref",
      "feature/screening",
    );
    await page.getByTestId("project-select-polsia").click();
    await expect(page.getByTestId("agent-map-project-name")).toHaveText("polsia");
    // Another project starts on its own working copy, outside git.
    await expect(page.getByTestId("agent-map-live")).not.toHaveAttribute("data-ref", /.*/);
    await expect(page.getByTestId("project-map-ref")).toHaveCount(0);

    await page.getByTestId("project-select-acme-app").click();
    await expect(page.getByTestId("agent-map-project-name")).toHaveText("acme-app");
    await expect(page.getByTestId("agent-map-live")).toHaveAttribute(
      "data-ref",
      "feature/screening",
    );
    await expect(page.getByTestId("project-map-ref")).toHaveAttribute(
      "data-ref",
      "feature/screening",
    );
    await expect(page.getByTestId("map-node-changed-screening")).toHaveAttribute(
      "aria-label",
      "Changed since feature/screening",
    );
    // The read after coming back used that ref, not the working copy.
    await expect.poll(async () => (await calls(page)).at(-1)).toMatchObject({
      ref: "feature/screening",
    });
  });

  test("returning to a drawn map reuses its positions: no arranging flash on a ref switch or a round trip", async ({
    page,
  }) => {
    await openReady(page);
    // Warm the other project so its return is also drawn from the cache.
    await page.getByTestId("project-select-polsia").click();
    await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute("data-layout-state", "ready");
    await page.getByTestId("project-select-acme-app").click();
    await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute("data-layout-state", "ready");
    await expect(node(page, "leasing")).toBeVisible();

    const slugs = [...IN_SYSTEM, "rent-reminder"];
    // Rounded to a tenth of a pixel: the fit zoom is re-measured on return.
    const positions = async () =>
      Promise.all(
        slugs.map(async (slug) => {
          const { x, y, width, height } = await box(node(page, slug));
          return [x, y, width, height].map((value) => Math.round(value * 10) / 10);
        }),
      );
    const before = await positions();
    // A canvas that had to be arranged again would show the layout-loading
    // state for a frame or more.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { arranging: string[] }).arranging = seen;
      const note = (element: Element) => {
        if (
          element.getAttribute("data-layout-state") === "loading" ||
          element.querySelector('[data-testid="agent-map-layout-loading"]') ||
          element.getAttribute("data-testid") === "agent-map-layout-loading"
        )
          seen.push("loading");
      };
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.target instanceof Element) note(record.target);
          for (const added of record.addedNodes)
            if (added instanceof Element) note(added);
        }
      }).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-layout-state"],
      });
    });
    await chooseRef(page, "main");
    await expect(page.getByTestId("agent-map-live")).toHaveAttribute("data-ref", "main");
    await page.getByTestId("project-select-polsia").click();
    await expect(node(page, "rollup")).toBeVisible();
    await page.getByTestId("project-select-acme-app").click();
    await expect(page.getByTestId("agent-map-live")).toHaveAttribute("data-ref", "main");
    await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
      "data-layout-state",
      "ready",
    );
    await expect(node(page, "leasing")).toBeVisible();
    expect(await positions()).toEqual(before);
    expect(
      await page.evaluate(() => (window as unknown as { arranging: string[] }).arranging),
    ).toEqual([]);
  });

  test("a project outside git has only refresh, and draws its agents loose", async ({ page }) => {
    await openReady(page, "polsia");
    await expect(page.getByTestId("agent-map-project-name")).toHaveText("polsia");
    await expect(page.getByTestId("agent-map-count")).toHaveText("8 agents");
    await expect(page.getByTestId("project-map-ref")).toHaveCount(0);
    await expect(page.getByTestId("project-map-refresh")).toBeVisible();
    await expect(page.locator("[data-system-id]")).toHaveCount(0);
    await expect(page.locator('[data-testid^="agent-map-edge-"]')).toHaveCount(0);
    await expect(node(page, "rollup")).toBeVisible();
  });

  test("refresh re-reads once, keeps every node where it was, and is busy while it reads", async ({
    page,
  }) => {
    await openReady(page);
    const slugs = [...IN_SYSTEM, "rent-reminder"];
    const snapshot = async () => ({
      system: await box(page.getByTestId(SYSTEM)),
      nodes: await Promise.all(slugs.map((slug) => box(node(page, slug)))),
      view: await page
        .getByTestId("agent-map-subject")
        .evaluate((element) => (element as HTMLElement).style.transform),
    });
    const before = await snapshot();
    const reads = await callCount(page);
    const refresh = page.getByTestId("project-map-refresh");
    // React flushes a click's state in a microtask, so the busy state is read
    // before any timer runs instead of racing the mock's 180 ms read.
    const busy = await refresh.evaluate(async (element) => {
      (element as HTMLButtonElement).click();
      await Promise.resolve();
      return {
        busy: element.getAttribute("aria-busy"),
        refreshing: element.getAttribute("data-refreshing"),
        disabled: (element as HTMLButtonElement).disabled,
      };
    });
    expect(busy).toEqual({ busy: "true", refreshing: "true", disabled: true });
    await expect.poll(() => callCount(page)).toBe(reads + 1);
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    await expect(refresh).not.toHaveAttribute("data-refreshing", /.*/);
    await expect(refresh).toBeEnabled();
    expect(await callCount(page)).toBe(reads + 1);
    expect(await snapshot()).toEqual(before);
  });
});

test.describe("project-map.changed", () => {
  test("a burst of three messages reads once, and another project's message reads nothing", async ({
    page,
  }) => {
    await openReady(page);
    const projectId = (await page.getByTestId("agent-map-live").getAttribute("data-project-id"))!;
    const reads = await callCount(page);
    await publishMapChanged(page, projectId, 3);
    await expect.poll(() => callCount(page)).toBe(reads + 1);
    // Only a wait can show that no second read follows: it outlasts the 250 ms
    // debounce plus the mock's 180 ms read.
    await page.waitForTimeout(900);
    expect(await callCount(page)).toBe(reads + 1);

    await publishMapChanged(page, "project_someone_else", 2);
    await page.waitForTimeout(900);
    expect(await callCount(page)).toBe(reads + 1);
  });
});

test.describe("picking an agent", () => {
  test("click leasing: the card offers Open agent and Open in Finder; Open agent opens the modal and Escape returns with the pick kept", async ({
    page,
  }) => {
    await openReady(page);
    await node(page, "leasing").click();
    const card = page.getByTestId("map-card");
    await expect(card).toHaveAttribute("data-subject", "leasing");
    await expect(page.getByTestId("map-card-open-agent")).toBeVisible();
    await expect(page.getByTestId("map-card-reveal")).toBeVisible();
    await expect(node(page, "leasing")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("agent-map-open-error")).toHaveCount(0);

    await page.getByTestId("map-card-open-agent").click();
    await expect(page.getByTestId("agent-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-modal")).toHaveCount(0);
    await expect(page.getByTestId("agent-map-live")).toBeVisible();
    await expect(node(page, "leasing")).toHaveAttribute("aria-pressed", "true");
    await expect(card).toHaveAttribute("data-subject", "leasing");
  });

  test("double-click leasing opens the agent modal", async ({ page }) => {
    await openReady(page);
    await node(page, "leasing").dblclick();
    await expect(page.getByTestId("agent-modal")).toBeVisible();
    await expect(page.getByTestId("agent-modal")).toHaveAttribute("data-agent", "leasing");
  });

  test("click an agent the agent list does not hold: Studio adds its folder and the card opens it", async ({
    page,
  }) => {
    await openReady(page);
    await node(page, "applicant-notifier").click();
    await expect(page.getByTestId("map-card")).toHaveAttribute("data-subject", "applicant-notifier");
    await expect(page.getByTestId("map-card-open-agent")).toBeVisible();
    await expect(page.getByTestId("map-card-reveal")).toBeVisible();
    await expect(page.getByTestId("agent-map-open-error")).toHaveCount(0);
    await page.getByTestId("map-card-open-agent").click();
    await expect(page.getByTestId("agent-modal")).toHaveAttribute("data-agent", "applicant-notifier");
  });

  test("click an agent Studio cannot add: a card with no verbs, and the map says why", async ({ page }) => {
    await openReady(page, "acme-app", "&mockConnectRefuse=screening");
    await node(page, "screening").click();
    await expect(page.getByTestId("map-card")).toHaveAttribute("data-subject", "screening");
    await expect(page.getByTestId("map-card-open-agent")).toHaveCount(0);
    await expect(page.getByTestId("map-card-reveal")).toHaveCount(0);
    await expect(page.getByTestId("agent-map-open-error")).toContainText(
      "Studio couldn't open screening as an agent.",
    );
  });
});

test.describe("states", () => {
  test("a failed read shows Reload map, and Reload map reads again", async ({ page }) => {
    await select(page, "acme-app", "&mockProjectMap=error");
    await expect(page.getByTestId("agent-map-load-error")).toBeVisible();
    await expect(page.getByTestId("agent-map-load-error")).toContainText(
      "The map could not be computed",
    );
    await expect(page.getByTestId("agent-map-canvas")).toHaveCount(0);
    expect(await callCount(page)).toBe(0);
    // The mock reads its flag from the URL on every read: clearing it is the
    // server recovering, so only a real second read can draw the map.
    await page.evaluate(() => {
      history.replaceState(null, "", "/?seed=0&mockFixtures=deep&mockStudioProjects=present");
    });
    await page.getByTestId("agent-map-retry").click();
    await expect(page.getByTestId("agent-map-canvas")).toBeVisible();
    await expect(page.getByTestId("agent-map-load-error")).toHaveCount(0);
    expect(await callCount(page)).toBe(1);
  });

  test("a missing project is unavailable, with no retry", async ({ page }) => {
    await select(page, "acme-app", "&mockProjectMap=missing");
    await expect(page.getByTestId("agent-map-project-unavailable")).toBeVisible();
    await expect(page.getByTestId("agent-map-retry")).toHaveCount(0);
    await expect(page.getByTestId("agent-map-canvas")).toHaveCount(0);
  });

  test("a project whose folder is gone (409) is unavailable, with no retry", async ({ page }) => {
    await select(page, "acme-app", "&mockProjectMap=gone");
    await expect(page.getByTestId("agent-map-project-unavailable")).toBeVisible();
    await expect(page.getByTestId("agent-map-retry")).toHaveCount(0);
  });

  test("without a deploy state no node carries a badge", async ({ page }) => {
    await openReady(page, "acme-app", "&mockProjectMapDeployed=0");
    await expect(page.locator(".agent-map-node")).toHaveCount(4);
    await expect(page.locator(".agent-map-deployment")).toHaveCount(0);
    await expect(page.locator("[data-deployment-state]")).toHaveCount(0);
  });
});
