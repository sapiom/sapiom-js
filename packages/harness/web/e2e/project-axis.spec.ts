/**
 * The Project axis, rendered.
 *
 * Every assertion here is one that is ONLY true on screen. Compaction, the
 * immediate-parent prefix, the one-flex-unit name and the icon-as-disclosure
 * all have unit coverage for their logic in `project-tree.test.ts`; what a unit
 * test cannot see is whether the row that logic produces is legible at rail
 * width. Three things in the reference prototype were reported met while
 * broken for exactly that reason — the code existed and had never been
 * rendered against a fixture deep enough to exercise it.
 *
 * Runs against `?mockFixtures=deep`, the only fixture with a multi-segment
 * directory, an agent path prefix, and a container holding both an agent and a
 * subdirectory. See `MOCK_DEEP_WORKFLOWS` for what it produces and why.
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const ROOT = "/Users/demo/polsia";
/** `polsia/services/workers` opened as its own project. */
const NESTED_LABEL = "polsia/services/workers";

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=deep");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
});

/**
 * The CHILD rows of one container, in DOM order, as `kind:label` strings. The
 * container's own row is not one of its children, so it never appears here.
 */
async function rowOrder(container: Locator): Promise<string[]> {
  return container.evaluate((element) =>
    Array.from(element.children)
      .map((child) => {
        if (child.classList.contains("workflow-item")) {
          return `agent:${child.getAttribute("data-testid")?.replace(/^workflow-/, "") ?? ""}`;
        }
        if (child.classList.contains("workspace-subgroup")) {
          const row = child.querySelector(":scope > .workspace-row");
          return `dir:${row?.getAttribute("data-testid")?.replace(/^dir-row-/, "") ?? ""}`;
        }
        return null;
      })
      .filter((entry): entry is string => entry != null),
  );
}

const opacityOf = (locator: Locator): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).opacity);

test.describe("compaction", () => {
  test("two agents under one deep chain render as ONE directory row with two agent rows", async ({
    page,
  }) => {
    // A directory only earns a row where the tree BRANCHES: `backend` and
    // `backend/src` each have exactly one child and no agent, so they merge
    // into the branch point rather than spending two rows to say nothing.
    const dir = page.getByTestId("dir-row-backend/src/agents");
    await expect(dir).toBeVisible();
    await expect(dir.locator(".tree-row-label")).toHaveText(
      "backend/src/agents",
    );
    await expect(page.getByTestId("dir-row-backend")).toHaveCount(0);
    await expect(page.getByTestId("dir-row-backend/src")).toHaveCount(0);

    const group = page.locator(".workspace-subgroup", { has: dir });
    expect(await rowOrder(group)).toEqual(["agent:ads", "agent:outreach"]);
  });

  test("a lone agent's whole chain compacts onto its OWN row as a prefix", async ({
    page,
  }) => {
    // Three directories leading to one agent is three rows to reach one thing.
    await expect(page.getByTestId("dir-row-scripts")).toHaveCount(0);
    await expect(page.getByTestId("dir-row-scripts/tools")).toHaveCount(0);

    const row = page.getByTestId("workflow-rollup");
    await expect(row).toBeVisible();
    // The IMMEDIATE PARENT only. The abbreviated chain rendered `harness/……
    // mail…` — the chain's own ellipsis plus a CSS one — and an unreadable
    // agent name; a shrink ratio cannot fix that, because flex shrinks in
    // proportion to basis and the long path has the larger basis.
    await expect(
      page.getByTestId(
        "workflow-prefix-/Users/demo/polsia/scripts/tools/rollup",
      ),
    ).toHaveText("tools");
    await expect(
      page.getByTestId("workflow-name-/Users/demo/polsia/scripts/tools/rollup"),
    ).toHaveText("rollup");
  });

  test("a 3-segment 18-character label stays WHOLE; a 5-segment 35-character one elides", async ({
    page,
  }) => {
    // Elision needs >2 segments AND >22 characters — both, so a short deep
    // chain keeps the only context the row had.
    await expect(
      page.getByTestId("dir-row-backend/src/agents").locator(".tree-row-label"),
    ).toHaveText("backend/src/agents");
    await expect(
      page
        .getByTestId("dir-row-packages/harness/web/src/components")
        .locator(".tree-row-label"),
    ).toHaveText("packages/…/components");
  });

  test("a mixed container holds an agent row AND a subdirectory", async ({
    page,
  }) => {
    const group = page.locator(".workspace-subgroup", {
      has: page.getByTestId("dir-row-services"),
    });
    expect(await rowOrder(group)).toEqual(["agent:gateway", "dir:workers"]);
  });
});

test.describe("ordering", () => {
  test("agents precede directories in EVERY container, at more than one depth", async ({
    page,
  }) => {
    // Deliberately unlike a file explorer: the rail explores AGENTS and
    // directories are scaffolding. Dirs-first buried the agent a project is
    // named for underneath the folder holding what it launches.
    const kindsOf = (rows: string[]): string[] =>
      rows.map((row) => row.split(":")[0]);
    const agentsFirst = (rows: string[]): boolean => {
      const kinds = kindsOf(rows);
      return (
        kinds.indexOf("agent") === -1 ||
        kinds.lastIndexOf("agent") <
          (kinds.indexOf("dir") === -1 ? Infinity : kinds.indexOf("dir"))
      );
    };

    // Depth 0 — directly under the project row. `rollup` (an agent) comes
    // before all three directory rows.
    const project = page.getByTestId("workspace-group-polsia");
    const top = await rowOrder(project);
    expect(top).toEqual([
      "agent:rollup",
      "dir:backend/src/agents",
      "dir:packages/harness/web/src/components",
      "dir:services",
    ]);

    // Depth 1 — inside `services`, the gateway agent comes before `workers`.
    const services = page.locator(".workspace-subgroup", {
      has: page.getByTestId("dir-row-services"),
    });
    const inside = await rowOrder(services);
    expect(inside).toEqual(["agent:gateway", "dir:workers"]);

    // And nothing anywhere in the tree violates it.
    for (const rows of [top, inside]) expect(agentsFirst(rows)).toBe(true);
  });
});

test.describe("the plan-first project children", () => {
  test("a root agent is a separate target below the pinned Agent Map", async ({
    page,
  }) => {
    const group = page.getByTestId("workspace-group-dashboard-keeper");
    const project = group.getByTestId("project-row-dashboard-keeper");
    const map = group.getByTestId("agent-map-row");
    const agent = group.getByTestId("workflow-dashboard-keeper");
    await expect(project).toBeVisible();
    await expect(map).toBeVisible();
    await expect(agent).toBeVisible();
    await expect(group.locator(":scope > *")).toHaveCount(3);

    // The project label is disclosure-only; the two children remain distinct.
    await page.getByTestId("project-select-dashboard-keeper").click();
    await expect(map).toBeHidden();
    await expect(agent).toBeHidden();
    await page.getByTestId("project-select-dashboard-keeper").click();
    await expect(map).toBeVisible();

    await group.getByTestId("agent-map-select").click();
    await expect(map).toHaveClass(/is-selected/);
    await expect(page.getByTestId("agent-map-empty")).toBeVisible();

    // A selected child expands on selection, but an intentional disclosure
    // click stays collapsed until the user expands it again.
    await page.getByTestId("project-select-dashboard-keeper").click();
    await expect(map).toBeHidden();
    await expect(
      page.getByTestId("project-disclosure-dashboard-keeper"),
    ).toHaveAttribute("aria-expanded", "false");
    await page.getByTestId("project-select-dashboard-keeper").click();
    await expect(map).toBeVisible();
    await expect(map).toHaveClass(/is-selected/);

    await agent.locator("button").click();
    await expect(agent).toHaveClass(/is-focused/);
    // Every durable project has at least the Agent Map child to disclose.
    await expect(
      page.getByTestId("project-disclosure-dashboard-keeper"),
    ).toHaveCount(1);
    await expect(page.getByTestId("project-disclosure-polsia")).toHaveCount(1);
  });

  test("the project row carries no deploy glyph; the agent child does", async ({
    page,
  }) => {
    const group = page.getByTestId("workspace-group-dashboard-keeper");
    await expect(
      group
        .getByTestId("project-row-dashboard-keeper")
        .locator(".workflow-status"),
    ).toHaveCount(0);
    await expect(
      group
        .getByTestId("workflow-dashboard-keeper")
        .locator(".workflow-status"),
    ).toHaveCount(1);
    // The rail also offers no per-project `+`.
    await expect(
      page.locator('.rail-list [data-testid^="workspace-new-session-"]'),
    ).toHaveCount(0);
  });

  test("a non-map destination clears the plan-first rail selection", async ({
    page,
  }) => {
    const map = page
      .getByTestId("workspace-group-dashboard-keeper")
      .getByTestId("agent-map-row");
    await map.getByTestId("agent-map-select").click();
    await expect(map).toHaveClass(/is-selected/);
    await expect(page.getByTestId("agent-map-empty")).toBeVisible();

    await page.getByTestId("rail-templates").click();
    await expect(page.getByTestId("templates-panel")).toBeVisible();
    await expect(map).not.toHaveClass(/is-selected/);
  });
});

test.describe("multi-root", () => {
  test("parent and nested project graphs follow their visible containment", async ({
    page,
  }) => {
    await page.getByTestId("project-select-polsia").click();
    await expect(page.getByTestId("system-graph-node-gateway")).toBeVisible();
    await expect(page.getByTestId("system-graph-node-queue")).toBeVisible();
    await expect(
      page.getByTestId("system-graph-node-ads-worker"),
    ).toBeVisible();

    await page.getByTestId(`project-select-${NESTED_LABEL}`).click();
    await expect(page.getByTestId("system-graph-node-queue")).toBeVisible();
    await expect(
      page.getByTestId("system-graph-node-ads-worker"),
    ).toBeVisible();
    await expect(page.getByTestId("system-graph-isolated-label")).toHaveText(
      "2 agents · no detected relationships",
    );
    await expect(page.getByTestId("system-graph-node-gateway")).toHaveCount(0);
  });

  test("an agent files under EVERY open root, and the nested project reads parent/child", async ({
    page,
  }) => {
    // Two roots are two contexts, and a session started in each has different
    // reach — so the same agent appearing twice is the point, not a bug.
    await expect(page.getByTestId("workflow-queue")).toHaveCount(2);
    const nested = page.getByTestId(`project-row-${NESTED_LABEL}`);
    await expect(nested).toBeVisible();
    // NOT a bare `workers`, which would be indistinguishable from the plain
    // subdirectory row of that name two indent levels away inside `polsia`.
    await expect(nested.locator(".tree-row-label")).toHaveText(NESTED_LABEL);
    // Under the nested root the agent sits AT the root, so it has no prefix.
    await expect(
      page
        .getByTestId(`workspace-group-${NESTED_LABEL}`)
        .getByTestId(
          "workflow-prefix-/Users/demo/polsia/services/workers/queue",
        ),
    ).toHaveCount(0);
    // Under `polsia` it is reached through `services/workers`.
    await expect(page.getByTestId("dir-row-workers")).toBeVisible();
  });

  test("collapsing the nested PROJECT does not collapse the same-named subdirectory", async ({
    page,
  }) => {
    // `project:/Users/demo/polsia/services/workers` and
    // `dir:/Users/demo/polsia/services/workers` are the same path. One shared
    // key collapsed both rows at once — same string, two different things.
    await expect(page.getByTestId("workflow-queue")).toHaveCount(2);

    await page.getByTestId(`project-disclosure-${NESTED_LABEL}`).click();

    // The project folded; the subdirectory inside `polsia` did not.
    await expect(
      page
        .getByTestId(`workspace-group-${NESTED_LABEL}`)
        .getByTestId("workflow-queue"),
    ).toHaveCount(0);
    await expect(page.getByTestId("dir-row-workers")).toBeVisible();
    await expect(page.getByTestId("workflow-queue")).toHaveCount(1);

    // And the inverse: folding the subdirectory leaves the project open.
    await page.getByTestId(`project-disclosure-${NESTED_LABEL}`).click();
    await page.getByTestId("dir-disclosure-workers").click();
    await expect(page.getByTestId("workflow-queue")).toHaveCount(1);
    await expect(
      page
        .getByTestId(`workspace-group-${NESTED_LABEL}`)
        .getByTestId("workflow-queue"),
    ).toHaveCount(1);
  });
});

test.describe("row chrome", () => {
  test("hovering a row swaps its left icon for a chevron, and NO row has a trailing one", async ({
    page,
  }) => {
    const row = page.getByTestId("dir-row-services");
    const mark = row.locator(".row-disclosure-mark");
    const chevron = row.locator(".row-disclosure-chevron");

    // At rest the row shows its identity, not a control.
    expect(await opacityOf(mark)).toBe("1");
    expect(await opacityOf(chevron)).toBe("0");

    await row.hover();
    await expect
      .poll(() => opacityOf(chevron), { message: "chevron reveals on hover" })
      .toBe("1");
    expect(await opacityOf(mark)).toBe("0");

    // A COLLAPSED row keeps its chevron unhovered: "there is more here" must
    // never be invisible.
    await page.getByTestId("dir-disclosure-services").click();
    await page.locator(".rail-header-label").hover();
    await expect
      .poll(() => opacityOf(chevron), {
        message: "a collapsed row keeps its chevron",
      })
      .toBe("1");

    // There is no trailing chevron column ANYWHERE in the tree — it reserved
    // width on every row to say something only needed at the moment of acting.
    await expect(page.locator(".rail-list .workspace-caret")).toHaveCount(0);
    const misplaced = await page
      .locator(".rail-list .workspace-row")
      .evaluateAll(
        (rows) =>
          rows.filter((row) => {
            const disclosure = row.querySelector(":scope > .row-disclosure");
            if (disclosure == null) return false; // the static stray-agents header
            return disclosure !== row.firstElementChild;
          }).length,
      );
    expect(misplaced, "every disclosure is the row's LEADING element").toBe(0);
  });

  test("the section header is a title, not a control", async ({ page }) => {
    // Folding it hid the only thing the rail is for and left a header sitting
    // on nothing.
    await expect(page.locator(".rail-header-label")).toHaveText("Projects");
    await expect(page.locator(".rail-header [aria-expanded]")).toHaveCount(1); // the sliders popover
    await expect(page.locator(".rail-header .row-disclosure")).toHaveCount(0);
    await expect(
      page.locator(".rail-header button[aria-expanded]"),
    ).toHaveAttribute("data-testid", "history-trigger");
  });

  test("the header's + sits LEFT OF the settings ellipsis, and adds a PROJECT", async ({
    page,
  }) => {
    await expect(page.getByTestId("rail-add-project")).toHaveAttribute(
      "aria-label",
      "Add a project",
    );

    // ORDER, asserted from the live DOM rather than from CSS: the LABEL owns the
    // leading edge, then `+`, then settings last. A control at the leading edge
    // put the header in the same icon slot and indent as the nav rows above it,
    // so it read as one more nav button rather than the title of the tree below.
    const headerOrder = await page
      .locator(".rail-header")
      .evaluate((el) =>
        [...el.querySelectorAll("[data-testid], .rail-header-label")].map(
          (n) => n.getAttribute("data-testid") ?? "label",
        ),
      );
    expect(headerOrder).toEqual([
      "label",
      "rail-add-project",
      "history-trigger",
    ]);

    // And the header's label is NOT indented like a nav row: it aligns to the
    // pane, where a section title belongs, not to the nav rows' icon slot.
    const indents = await page.evaluate(() => ({
      header: Math.round(
        document.querySelector(".rail-header-label")!.getBoundingClientRect()
          .left,
      ),
      navRow: Math.round(
        document
          .querySelector('[data-testid="add-existing-agents"] span')!
          .getBoundingClientRect().left,
      ),
    }));
    expect(indents.header).toBeLessThan(indents.navRow);

    await page.getByTestId("rail-add-project").click();
    await expect(page.locator(".modal-start")).toBeVisible();
    await page.keyboard.press("Escape");

    // AN ELLIPSIS, reversing the design doc's "sliders, not an ellipsis". That
    // rule held while the panel had exactly one subject; it now carries filing
    // AND past sessions, so sliders would promise filing and nothing else.
    //
    // VERTICAL, and it is the app's only overflow glyph — the horizontal one is
    // unregistered, because a horizontal ellipsis is what every truncated name
    // in this rail already renders. Asserted on the class lucide actually emits
    // (`lucide-ellipsis-vertical`), not on the component name: the earlier
    // version of this spec asserted `lucide-more-horizontal` and was wrong,
    // because a deprecated alias does not name its own output.
    await expect(
      page
        .getByTestId("history-trigger")
        .locator("svg.lucide-ellipsis-vertical"),
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId("history-trigger")
        .locator("svg.lucide-sliders-horizontal"),
    ).toHaveCount(0);
    // No HORIZONTAL ellipsis anywhere in the rail.
    await expect(page.locator(".rail-shell svg.lucide-ellipsis")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("history-trigger")).toHaveAttribute(
      "aria-label",
      "Rail settings",
    );
    await page.getByTestId("history-trigger").click();
    // VISIBLE dropdowns, not a menu of radio rows: each states its current
    // value on the face of the control.
    await expect(page.getByTestId("filing-group-by")).toBeVisible();
    await expect(page.getByTestId("filing-group-by")).toHaveValue("project");
    await expect(page.getByTestId("filing-sort-by")).toBeVisible();
    await expect(page.getByTestId("filing-sort-by")).toHaveValue("recent");
    // The Deployment axis is retired; Group took its slot (SAP-2929).
    await expect(page.getByTestId("group-deployment")).toHaveCount(0);
    await expect(
      page.getByTestId("filing-group-by").locator("option"),
    ).toHaveText(["Project", "Group"]);
  });

  test("Sort by actually reorders the projects, and the choice survives a reload", async ({
    page,
  }) => {
    // A control that stores a preference and changes nothing on screen is the
    // exact shape three prototype features shipped in.
    const labels = (): Promise<string[]> =>
      page
        .locator(
          ".rail-list > .workspace-group > .workspace-row .tree-row-label",
        )
        .allInnerTexts();

    // "recent" is the recentDirs MRU order, which is not alphabetical.
    expect(await labels()).toEqual([
      "acme-app",
      "rfq-agent",
      "onboarding-flow",
      "polsia",
      "polsia/services/workers",
      "dashboard-keeper",
      // `scratch` is a session cwd, not a recentDirs entry, so it ranks below
      // every folder the MRU list knows about. Every session cwd becomes a
      // project — there is no migration.
      "scratch",
    ]);

    await page.getByTestId("history-trigger").click();
    await page.getByTestId("filing-sort-by").selectOption("name");
    await page.keyboard.press("Escape");
    expect(await labels()).toEqual([
      "acme-app",
      "dashboard-keeper",
      "onboarding-flow",
      "polsia",
      "rfq-agent",
      "scratch",
      // Sorted by BASENAME — a nested project's label is widened for
      // disambiguation, but `workers` is what it is called.
      "polsia/services/workers",
    ]);

    await page.reload();
    await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
    await page.getByTestId("history-trigger").click();
    await expect(page.getByTestId("filing-sort-by")).toHaveValue("name");
  });
});

test.describe("legibility", () => {
  test("no agent name is ever clipped by its own prefix", async ({ page }) => {
    // The prefix is CONTEXT and the name is IDENTITY, so the prefix gives way
    // first. Flex distributes shrink in proportion to (factor × basis), which
    // is why a plain 1:1 ratio handed the shrinkage to whichever string was
    // longer — and a deep path is always the longer one.
    const clipped = await page
      .locator('.rail-list [data-testid^="workflow-name-"]')
      .evaluateAll((names) =>
        names
          .filter((name) => name.scrollWidth > name.clientWidth)
          .map(
            (name) =>
              `${name.textContent} (${name.scrollWidth} > ${name.clientWidth})`,
          ),
      );
    expect(clipped, "agent names are never truncated by their prefix").toEqual(
      [],
    );
    // The assertion is only meaningful if there ARE prefixed rows on screen.
    expect(
      await page.locator('.rail-list [class*="tree-row-prefix"]').count(),
    ).toBeGreaterThan(0);
  });

  test("the prefix, its slash and the name are ONE flex unit", async ({
    page,
  }) => {
    // As two children of the row, the row's gap opened a space INSIDE a path:
    // `scripts/tools/ rollup` read as two separate things.
    const parts = await page.getByTestId("workflow-rollup").evaluate((row) => {
      const unit = row.querySelector(".tree-row-name");
      const prefix = row.querySelector(".tree-row-prefix");
      const sep = row.querySelector(".tree-row-sep");
      const label = row.querySelector(".tree-row-label");
      return {
        allInsideOneUnit:
          unit != null &&
          [prefix, sep, label].every(
            (part) => part != null && unit.contains(part),
          ),
        // The `/` sits OUTSIDE the truncating span, so a clipped prefix keeps
        // its separator — inside it, `components/mailer` became
        // `componen…mailer`, one word where there were two things.
        separatorOutsidePrefix:
          sep != null && prefix != null && !prefix.contains(sep),
        sepText: sep?.textContent ?? "",
      };
    });
    expect(parts.allInsideOneUnit).toBe(true);
    expect(parts.separatorOutsidePrefix).toBe(true);
    expect(parts.sepText).toBe("/");

    // Rendered, the path reads as one location: no gap between the slash and
    // either side of it.
    const gaps = await page.getByTestId("workflow-rollup").evaluate((row) => {
      const prefix = row
        .querySelector(".tree-row-prefix")!
        .getBoundingClientRect();
      const sep = row.querySelector(".tree-row-sep")!.getBoundingClientRect();
      const label = row
        .querySelector(".tree-row-label")!
        .getBoundingClientRect();
      return [sep.left - prefix.right, label.left - sep.right];
    });
    for (const gap of gaps) expect(gap).toBeLessThan(3);
  });

  test("every row's title is its ABSOLUTE path", async ({ page }) => {
    // The row shows what it is — a name, or a compacted and maybe elided
    // chain. The title answers where it lives, and only the absolute path
    // answers that.
    await expect(
      page.getByTestId("project-row-polsia").locator(".workspace-row-main"),
    ).toHaveAttribute("title", ROOT);
    await expect(
      page
        .getByTestId("dir-row-backend/src/agents")
        .locator(".workspace-row-main"),
    ).toHaveAttribute("title", `${ROOT}/backend/src/agents`);
    await expect(
      page
        .getByTestId("dir-row-packages/harness/web/src/components")
        .locator(".workspace-row-main"),
    ).toHaveAttribute("title", `${ROOT}/packages/harness/web/src/components`);
    await expect(
      page.getByTestId("workflow-rollup").locator(".workflow-item-trigger"),
    ).toHaveAttribute("title", `${ROOT}/scripts/tools/rollup`);
    await expect(
      page
        .getByTestId("workspace-group-dashboard-keeper")
        .locator(".workspace-row-main"),
    ).toHaveAttribute("title", "/Users/demo/dashboard-keeper");

    // And no row in the tree is missing one, or carrying something that is not
    // a path — the old title repeated the label it was attached to.
    const bad = await page
      .locator(
        ".rail-list .workspace-row-main, .rail-list .workflow-item-trigger",
      )
      .evaluateAll((mains) =>
        mains
          .filter(
            (main) =>
              !/^\/Users\/demo(\/|$)/.test(main.getAttribute("title") ?? ""),
          )
          .map(
            (main) =>
              `${main.textContent?.trim()} → ${main.getAttribute("title")}`,
          ),
      );
    expect(bad).toEqual([]);
  });
});

test("the deep rail renders", async ({ page }: { page: Page }) => {
  await page.screenshot({
    path: "web/e2e/screenshots/project-axis.png",
    fullPage: true,
  });
});
