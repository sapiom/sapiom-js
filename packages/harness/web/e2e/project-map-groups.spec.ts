/**
 * RUNS ON THE COMPATIBILITY PAYLOAD (`mockStudioProjects=absent`).
 *
 * The subject here is the workspace System Graph a project row opens. On a
 * current server every project carries a durable Studio project and the row
 * opens that project's Agent Map instead, so this surface is reachable only on
 * the legacy payload, which is what `mockStudioProjects=absent` names. These
 * specs were already running on that payload before it had a name: mock mode
 * returned no Studio projects by default, so the whole suite did. Pinning takes
 * nothing away, it only stops the choice being an accident. The plan-first
 * equivalents of these behaviours are NOT covered here; see
 * `project-axis.spec.ts` and `agent-map-planning.spec.ts`.
 */
/**
 * SAP-2983 — the project map draws the groups the rail already has.
 *
 * The unit tests pin the two pure halves: `lib/system-graph-groups.test.ts`
 * decides which node belongs to which container, `lib/system-graph-layout.test.ts`
 * decides where the container goes. Neither can see the thing the ticket is
 * about — that the map READS the rail's arrangement at all, and that the two
 * surfaces agree on screen. A layout rule is not proven by a unit test, and a
 * map drawing a second opinion of the same groups would pass every one of them.
 *
 * `?mockFixtures=deep` is the fixture with a real group axis: `MOCK_LAUNCH_EDGES`
 * produces a three-member component (gateway), a two-member one (mailer), an
 * edge to an agent this install lacks, and agents no edge reaches — plus
 * `MOCK_POLSIA_GRAPH_EDGES`, whose connectors run BETWEEN those groups, which is
 * the cross-container case.
 *
 * Every assertion here was mutation-tested; what each mutation was, and which
 * assertion caught it, is on the PR.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/** The container labels the map draws, in DOM order. */
const mapContainers = (page: Page): Promise<(string | null)[]> =>
  page
    .locator(".system-graph-group")
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-group-label")),
    );

/** The group rows the RAIL draws for polsia, in DOM order. */
const railGroups = (page: Page): Promise<string[]> =>
  page
    .getByTestId("workspace-group-polsia")
    .locator('[data-testid^="group-row-"] .tree-row-label')
    .allInnerTexts();

/** Switch the rail to the Group axis. */
async function selectGroupAxis(page: Page): Promise<void> {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("filing-group-by").selectOption("group");
  await page.keyboard.press("Escape");
}

/** …and wait for it to be EDITABLE: the create row appears only once the
 *  arrangement and the launch edges have both loaded. */
async function openGroupAxis(page: Page): Promise<void> {
  await selectGroupAxis(page);
  await expect(page.getByTestId("group-create-polsia")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=deep&mockStudioProjects=absent");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  await expect(page.locator(".system-graph-group").first()).toBeVisible();
});

test("one labelled container per group, named exactly as the rail names it", async ({
  page,
}) => {
  // The whole ticket. Two names for one group is the failure it prevents, and
  // it is only visible with both surfaces on screen at once.
  await expect(page.locator(".system-graph-group")).toHaveCount(3);
  expect(await mapContainers(page)).toEqual(["gateway", "mailer", "Ungrouped"]);

  await openGroupAxis(page);
  expect(await railGroups(page)).toEqual(await mapContainers(page));
});

test("every card sits inside exactly one container, measured", async ({
  page,
}) => {
  /* GEOMETRY, not counts. A container assertion that still passes when the
     cards are drawn outside their boxes is worthless — and the boxes are
     absolutely positioned siblings of the cards, not their DOM parents, so
     "inside" is a claim only measurement can settle. */
  const placement = await page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const groups = [...document.querySelectorAll(".system-graph-group")].map(
      (el) => ({ label: el.getAttribute("data-group-label"), rect: box(el) }),
    );
    const contains = (outer: DOMRect, inner: DOMRect) =>
      inner.left >= outer.left - 0.5 &&
      inner.top >= outer.top - 0.5 &&
      inner.right <= outer.right + 0.5 &&
      inner.bottom <= outer.bottom + 0.5;
    return [...document.querySelectorAll(".system-graph-node")].map((el) => ({
      key: el.getAttribute("data-agent-key"),
      in: groups
        .filter((group) => contains(group.rect, box(el)))
        .map((group) => group.label),
    }));
  });

  expect(placement.length).toBeGreaterThan(0);
  for (const card of placement) {
    expect(card.in, `${card.key} is in exactly one container`).toHaveLength(1);
  }
  expect(
    placement.filter((card) => card.in[0] === "gateway").map((c) => c.key).sort(),
  ).toEqual(["ads-worker", "gateway", "queue"]);
  expect(
    placement.filter((card) => card.in[0] === "mailer").map((c) => c.key).sort(),
  ).toEqual(["mailer", "sender"]);
});

test("containers do not overlap, and none is drawn outside the map's own bounds", async ({
  page,
}) => {
  /* The subject box IS the layout's bounds, and the viewport's fit, its zoom
     floor and its "did the stored view still show anything" check all read
     them. A container drawn outside them is a container Fit cannot bring on
     screen — and it is invisible to any assertion that only counts boxes,
     which is how a row overflowing its rail by 17px shipped. */
  const measured = await page.evaluate(() => {
    const rects = [...document.querySelectorAll(".system-graph-group")].map(
      (el) => el.getBoundingClientRect(),
    );
    const overlaps: string[] = [];
    for (let left = 0; left < rects.length; left += 1) {
      for (let right = left + 1; right < rects.length; right += 1) {
        const a = rects[left]!;
        const b = rects[right]!;
        if (
          !(
            a.right <= b.left ||
            b.right <= a.left ||
            a.bottom <= b.top ||
            b.bottom <= a.top
          )
        ) {
          overlaps.push(`${left}/${right}`);
        }
      }
    }
    const subject = document
      .querySelector(".system-graph-subject")!
      .getBoundingClientRect();
    const escaping = rects.filter(
      (rect) =>
        rect.left < subject.left - 0.5 ||
        rect.top < subject.top - 0.5 ||
        rect.right > subject.right + 0.5 ||
        rect.bottom > subject.bottom + 0.5,
    ).length;
    return { count: rects.length, overlaps, escaping };
  });
  expect(measured.count).toBe(3);
  expect(measured.overlaps).toEqual([]);
  expect(measured.escaping).toBe(0);
});

test("a rail edit moves the map, with no reload", async ({ page }) => {
  /* The rail and the map are two views of ONE arrangement. Two copies of the
     state is exactly how they come to disagree: the file is the only shared
     medium and nothing re-reads it, so an edit in the rail would leave the map
     drawing what it read on mount. */
  await openGroupAxis(page);
  expect(await mapContainers(page)).toContain("gateway");

  await page.getByTestId("group-rename-gateway").click();
  await page.getByTestId("group-rename-input").fill("Ingest");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => mapContainers(page))
    .toEqual(["Ingest", "mailer", "Ungrouped"]);
  expect(await railGroups(page)).toEqual(await mapContainers(page));
});

test("an edge whose ends the user split across groups is still drawn", async ({
  page,
}) => {
  /* Pull one member out of a detected system and the connector between the
     halves is still real. Dropping it would make the map claim two systems
     never touch, which is the one thing an edge is for. */
  await openGroupAxis(page);
  const before = await page
    .locator('[data-testid^="system-graph-edge-"]')
    .count();
  expect(before).toBeGreaterThan(0);

  // `queue` leaves every group — the drop-on-Ungrouped gesture, applied
  // through the rail's own delete of the group that holds it.
  await page.getByTestId("group-delete-mailer").click();
  await expect.poll(() => mapContainers(page)).toEqual(["gateway", "Ungrouped"]);

  const after = await page
    .locator('[data-testid^="system-graph-edge-"]')
    .count();
  expect(after).toBe(before);
  await expect(page.locator(".system-graph-edge.is-cross-group")).not.toHaveCount(
    0,
  );
});

test("a container's name stays inside its own box at every zoom", async ({
  page,
}) => {
  /* The name counter-scales against the view zoom, because at the map's own
     arrival zoom it renders under 4px tall. A `transform: scale()` would do
     that WITHOUT re-laying the line out — the label's on-screen width would
     then stay constant while its container's shrank, so below ~70% a long group
     name draws past its own box and over its neighbour, invisible to any check
     that measures the boxes alone. It grows by font-size instead, so the
     ellipsis still applies.

     Asserted at the far end of the clamp, where a transform would be worst. */
  await page.getByTestId("system-graph-zoom-out").click({ clickCount: 8 });

  const measured = await page.evaluate(() => {
    const groups = [...document.querySelectorAll(".system-graph-group")];
    const cards = [...document.querySelectorAll(".system-graph-node")].map(
      (el) => el.getBoundingClientRect(),
    );
    const hits = (a: DOMRect, b: DOMRect) =>
      !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    return {
      zoom: document.querySelector('[data-testid="system-graph-zoom-reset"]')!
        .textContent,
      labelHeight: Math.round(
        groups[0]!
          .querySelector(".system-graph-group-label")!
          .getBoundingClientRect().height,
      ),
      escaping: groups.filter((group) => {
        const outer = group.getBoundingClientRect();
        const label = group
          .querySelector(".system-graph-group-label")!
          .getBoundingClientRect();
        return (
          label.right > outer.right + 0.5 || label.bottom > outer.bottom + 0.5
        );
      }).length,
      overCards: groups.filter((group) => {
        const label = group
          .querySelector(".system-graph-group-label")!
          .getBoundingClientRect();
        return cards.some((card) => hits(label, card));
      }).length,
    };
  });

  // The fixture is only evidence while the label is actually being grown.
  expect(Number.parseInt(measured.zoom!, 10)).toBeLessThan(70);
  expect(measured.labelHeight).toBeGreaterThan(6);
  expect(measured.escaping).toBe(0);
  expect(measured.overCards).toBe(0);
});

test("a project whose arrangement cannot be READ still draws its groups", async ({
  page,
}) => {
  /* The write gate and the draw gate are different questions. A read that fails
     answers "nothing stored", which shows the DERIVED groups — the rail renders
     those, because a group axis you cannot write to is still one you can look
     at. Gating the map on the write gate instead would leave it flat and
     unlabelled on a read-only checkout while the rail six inches away named
     every system, which is the divergence this whole feature removes. */
  await page.goto("/?mockFixtures=deep&mockStudioProjects=absent");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __MOCK_RAIL_STATE_FAIL__?: boolean }).__MOCK_RAIL_STATE_FAIL__ =
      true;
  });
  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();

  await expect
    .poll(() => mapContainers(page))
    .toEqual(["gateway", "mailer", "Ungrouped"]);

  // The rail draws the same rows — read-only, which is why the map cannot be
  // gated on the same signal: `group-create-polsia` is deliberately absent.
  await selectGroupAxis(page);
  await expect
    .poll(() => railGroups(page))
    .toEqual(["gateway", "mailer", "Ungrouped"]);
  await expect(page.getByTestId("group-create-polsia")).toHaveCount(0);
  expect(await railGroups(page)).toEqual(await mapContainers(page));
});

test("a read that failed is tried again when the map is reopened", async ({
  page,
}) => {
  /* The arrangement cache is shared by both surfaces so an edit in one moves
     the other. What must NOT be shared is "have I asked for this yet": a
     module-level request latch would mean one bad response is permanent, and
     that this committable file is never re-read after a branch switch or a hand
     edit either. So the latch stays per surface, and a remount re-reads. */
  await page.goto("/?mockFixtures=deep&mockStudioProjects=absent");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.evaluate(() => {
    // A stored arrangement, so a successful read is distinguishable from a
    // failed one by more than timing.
    window.localStorage.setItem(
      "sapiom-mock-studio-rail:/Users/demo/polsia",
      JSON.stringify({
        version: 1,
        renames: {},
        groups: [
          {
            id: "g_custom",
            label: "Custom",
            members: [
              "/Users/demo/polsia/services/gateway",
              "/Users/demo/polsia/services/workers/queue",
            ],
          },
        ],
      }),
    );
    (window as unknown as { __MOCK_RAIL_STATE_FAIL__?: boolean }).__MOCK_RAIL_STATE_FAIL__ =
      true;
  });

  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  // The read failed, so the map falls back to the DERIVED groups.
  await expect
    .poll(() => mapContainers(page))
    .toEqual(["gateway", "mailer", "Ungrouped"]);

  await page.evaluate(() => {
    (window as unknown as { __MOCK_RAIL_STATE_FAIL__?: boolean }).__MOCK_RAIL_STATE_FAIL__ =
      false;
  });

  // Drill into an agent and back out: the map remounts, and the remount reads.
  await page.locator(".system-graph-node.is-navigable").first().click();
  await expect(page.getByTestId("workspace-graph-view")).toHaveCount(0);
  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();

  await expect.poll(() => mapContainers(page)).toEqual(["Custom", "Ungrouped"]);
});

test("opening the map cannot undo an edit the rail just made", async ({
  page,
}) => {
  /* The arrangement is shared across surfaces but the request latch is per
     surface, so opening the map issues its OWN read of the file — and that read
     races any write still in flight from an edit a moment earlier. Served
     first, it would replace the optimistic arrangement with the pre-edit file:
     the rail visibly reverts, and the next edit then materializes from the
     reverted state and persists it, losing the edit on disk as well as on
     screen. A root this page has written to is never re-read.

     The write is held open here so the race is deterministic rather than a
     matter of who happens to win. */
  await page.goto("/?mockFixtures=deep&mockStudioProjects=absent");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openGroupAxis(page);

  let releaseWrite = (): void => {};
  const writeHeld = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  await page.exposeFunction("__holdRailWrite", () => writeHeld);
  await page.evaluate(() => {
    const store = window.localStorage;
    const original = store.setItem.bind(store);
    store.setItem = (key: string, value: string) => {
      if (key.startsWith("sapiom-mock-studio-rail:")) {
        void (window as unknown as { __holdRailWrite: () => Promise<void> })
          .__holdRailWrite()
          .then(() => original(key, value));
        return;
      }
      original(key, value);
    };
  });

  // The edit: optimistic in memory, its write parked.
  await page.getByTestId("group-rename-gateway").click();
  await page.getByTestId("group-rename-input").fill("Ingest");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => railGroups(page))
    .toEqual(["Ingest", "mailer", "Ungrouped"]);

  // Opening the map is what issues the second read.
  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  await expect
    .poll(() => mapContainers(page))
    .toEqual(["Ingest", "mailer", "Ungrouped"]);

  releaseWrite();
  // Still the edit, on both surfaces, after the write lands.
  await expect.poll(() => railGroups(page)).toEqual(["Ingest", "mailer", "Ungrouped"]);
  expect(await mapContainers(page)).toEqual(["Ingest", "mailer", "Ungrouped"]);
});
