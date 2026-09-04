/**
 * THE ONE CREATE VERB, and where each of its branches actually lands.
 *
 * `handleNewAgentIn` (App.tsx) is this PR's whole payload and nothing asserted
 * it. Every spec the change touched was updated to assert the MENU OPENING,
 * which is the step before the one that matters — a handler that resolved the
 * wrong scope and fell through to the compatibility dialog with the wrong
 * project's name would have left the whole suite green.
 *
 * So these assert the destination, on both branches and on the folder step:
 *
 *  1. a project WITH a durable Studio project → its Agent Map, which is what
 *     owns creation inside a project (#790). `agent-map-select` is pressed and
 *     the map frame is the right pane's subject.
 *  2. a project WITHOUT one (`mockStudioProjects=absent`, the legacy payload) →
 *     the create dialog, NAMING THAT PROJECT. The name is asserted because the
 *     documented failure is falling through silently with the wrong one.
 *  3. the web folder step continues into 1 rather than merely registering the
 *     folder, which is the difference between the verb and the ⋮'s "Add
 *     existing agents".
 *  4. a failure anywhere in it is reported. Both call sites are
 *     `void onNewAgentIn(...)` from a control that has already closed its
 *     popover, so an unhandled rejection is a dead end with no symptom.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Everything the app has done to create things, in order — the same probe
 *  `create-agent.spec.ts` reads, so "and it created nothing" is checkable. */
const createOrder = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      ((window as unknown as { __HARNESS_TEST__?: { createOrder?: string[] } })
        .__HARNESS_TEST__?.createOrder ?? []) as string[],
  );

/** The prompt text last injected into a session, if any. The verb must never
 *  produce one: that is the mechanism SAP-2981 exists to remove. */
const lastInjectText = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { lastInjectInput?: { req?: { text?: string } } };
        }
      ).__HARNESS_TEST__?.lastInjectInput?.req?.text ?? "",
  );

test.describe("the create verb lands somewhere", () => {
  test("both entrances land on the new agent screen, scoped to the project", async ({
    page,
  }) => {
    // THE SWAP THIS PR EXISTS FOR, asserted on both entrances.
    //
    // The screen with the good surface had the wrong plumbing (it invented a
    // folder from a slug and typed English at the coding agent); the path with
    // the right plumbing had no surface. One screen now, two ways in.
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // ENTRANCE ONE: a project you already have.
    await page.getByTestId("rail-create-new").click();
    await page.getByTestId("new-agent-in-acme-app").click();
    await expect(page.getByTestId("new-session-composer")).toBeVisible();
    // It NAMES the project, so the second entrance cannot leave you guessing
    // where the agent will live.
    await expect(page.getByTestId("composer-greeting")).toContainText(
      "in acme-app",
    );

    // ENTRANCE TWO: a folder that is not a project yet. On the browser host the
    // folder step falls back to the dialog; on desktop it is the OS picker and
    // no dialog opens (`folder-step.test.ts` covers that half).
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("rail-create-new").click();
    await page.getByTestId("new-agent-choose-folder").click();
    await page
      .getByTestId("folder-field-input")
      .fill("/Users/demo/blank-slate");
    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("new-session-composer")).toBeVisible();
    await expect(page.getByTestId("composer-greeting")).toContainText(
      "in blank-slate",
    );
  });

  test("submitting in a project dispatches the planner and types no English", async ({
    page,
  }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("rail-create-new").click();
    await page.getByTestId("new-agent-in-acme-app").click();
    await expect(page.getByTestId("new-session-composer")).toBeVisible();

    const before = await page.evaluate(
      () =>
        ((window as unknown as { __HARNESS_TEST__?: { openPlannerSessionCalls?: unknown[] } })
          .__HARNESS_TEST__?.openPlannerSessionCalls ?? []).length,
    );
    const idea = "Diff our competitors' pricing pages weekly.";
    await page.getByTestId("composer-input").fill(idea);
    await page.getByTestId("composer-send").click();

    // The planner opened for this project...
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            ((window as unknown as { __HARNESS_TEST__?: { openPlannerSessionCalls?: unknown[] } })
              .__HARNESS_TEST__?.openPlannerSessionCalls ?? []).length,
        ),
      )
      .toBeGreaterThan(before);
    // ...and what reached it is the user's own sentence, not a request that the
    // coding agent please call a scaffold tool. `composerScaffoldPrompt` names
    // the tool explicitly, so its absence is checkable rather than inferred.
    await expect.poll(() => lastInjectText(page)).toContain(idea);
    expect(await lastInjectText(page)).not.toContain("sapiom_dev_agents");
  });

  test("a project with an Agent Map: the verb opens that map", async ({
    page,
  }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("rail-create-new").click();
    await page.getByTestId("new-agent-in-acme-app").click();

    // THE DESTINATION, not the menu.
    const group = page.getByTestId("workspace-group-acme-app");
    await expect(group.getByTestId("agent-map-select")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("agent-map-frame")).toBeVisible();

    // AND THE DIALOG NEVER APPEARS, held for a window rather than sampled once.
    // This is the assertion that separates the two branches, and it has to be
    // the patient one: on the fall-through the map ALSO ends up selected (the
    // project-restore effect gets there on its own once the folder is open), so
    // the map assertions above are true either way and only this one is not.
    // A single `toHaveCount(0)` raced the dialog's first paint and passed while
    // the branch was broken — measured, not assumed.
    await expect
      .poll(() => page.getByTestId("create-agent-dialog").count(), {
        timeout: 2_000,
        intervals: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
      })
      .toBe(0);
    await expect(page.getByTestId("create-agent-dialog")).toHaveCount(0);

    // NO AGENT WAS SCAFFOLDED BEHIND IT, and no English was typed at anybody.
    // Not "nothing happened": landing on the map starts its planner session
    // (`use-agent-map-entry.ts:400-423` calls `loadPlanner(…, "resume-or-create")`
    // off the selection), so `createOrder` legitimately carries a `session:`
    // entry. That session IS the creation surface. What must never appear is a
    // `scaffold:` — the harness making an agent behind the user's back — or the
    // prompt injection this verb was rewired to stop reaching.
    // The planner session is started by an effect off the selection, so it can
    // land after the map paints. Waited for, not sampled.
    await expect
      .poll(() => createOrder(page), { timeout: 10_000 })
      .toContain("session:/Users/demo/acme-app");
    const order = await createOrder(page);
    expect(order.filter((entry) => entry.startsWith("scaffold:"))).toEqual([]);
    expect(await lastInjectText(page)).not.toContain("sapiom_dev_agents");
  });

  test("a legacy payload: the verb opens the create dialog, naming that project", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=absent");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("rail-create-new").click();
    await page.getByTestId("new-agent-in-acme-app").click();

    await expect(page.getByTestId("create-agent-dialog")).toBeVisible();
    // THE NAME IS THE ASSERTION. Resolving the wrong scope falls through to
    // this same dialog carrying the wrong folder's basename, and a spec that
    // only checked the dialog was visible would pass on exactly that bug.
    await expect(page.getByTestId("create-agent-project")).toHaveText(
      "acme-app",
    );
    expect(await createOrder(page)).toEqual([]);
  });

  test("the folder step continues into the flow, it does not just register", async ({
    page,
  }) => {
    // The browser host, which is what Playwright is: the folder step falls back
    // to the dialog here. On desktop it is the OS picker and no dialog opens —
    // `folder-step.test.ts` covers that branch, since Electron cannot run here.
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("rail-create-new").click();
    await page.getByTestId("new-agent-choose-folder").click();
    await expect(page.locator(".modal-start")).toBeVisible();
    await page
      .getByTestId("folder-field-input")
      .fill("/Users/demo/blank-slate");
    await page.getByTestId("open-project").click();

    // Registering the folder is the ⋮'s job and it stops there. The VERB keeps
    // going: the new project is open AND its map is the subject.
    const group = page.getByTestId("workspace-group-blank-slate");
    await expect(group).toBeVisible();
    await expect(group.getByTestId("agent-map-select")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("agent-map-frame")).toBeVisible();
  });

  test("a failure is reported, not swallowed", async ({ page }) => {
    // The verb opens the folder and then RE-READS the workspace to find the
    // project it just made. The popover has already closed by then, so without
    // a catch the only trace of a 500 on that read is an unhandled rejection in
    // a console nobody has open: the control simply does nothing.
    //
    // The read, not the settings write, because `rememberProjectDir` swallows
    // its own 500 by design (`use-harness-state.ts:1503-1513`) and `openProject`
    // therefore does not reject. Injecting there would have tested nothing.
    await page.goto("/?seed=0&mockError=stateRefresh");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("rail-create-new").click();
    await page.getByTestId("new-agent-in-acme-app").click();

    await expect(page.getByTestId("toast")).toContainText(
      /Couldn't open .* to create an agent in/i,
    );
    await expect(page.getByTestId("create-agent-dialog")).toHaveCount(0);
  });
});

test.describe("⌘K over an open dialog", () => {
  test("the palette does not stack on top of a dialog", async ({ page }) => {
    // Found by the dialog-shell work (#800), which stopped at `App.tsx` rather
    // than reaching into it. The pane-collapse hotkey directly above the ⌘K
    // handler already bails when a layer is open; ⌘K did not, so the palette
    // opened over the dialog and native Tab then walked out of the palette into
    // the dialog behind it. `CommandPalette` carries no `role`, so the guard has
    // to match `.modal-backdrop` — a role-only selector cannot see it.
    await page.goto("/?seed=0&mockStudioProjects=absent");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("rail-create-new").click();
    await page.getByTestId("new-agent-in-acme-app").click();
    await expect(page.getByTestId("create-agent-dialog")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("command-palette-input")).toHaveCount(0);
    // The dialog is still the top layer and still the thing that has focus.
    await expect(page.getByTestId("create-agent-dialog")).toBeVisible();

    // And the shortcut is not broken — it works again once the layer is gone.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("create-agent-dialog")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("command-palette-input")).toBeVisible();
  });

  test("⌘P over a dialog is swallowed, not handed to the browser", async ({
    page,
  }) => {
    // THE SAME HANDLER OWNS ⌘P, and ⌘P is the browser's PRINT shortcut. A guard
    // that returns early WITHOUT preventing the event stops the palette and
    // hands ⌘P to the browser, which opens a native print preview over the
    // dialog — worse than the stacking it was added to stop, and invisible to a
    // spec that only presses ⌘K.
    //
    // `defaultPrevented` IS THE ASSERTION, not `beforeprint`. Headless Chromium
    // never fires `beforeprint` for an unhandled Ctrl+P, so a spec written that
    // way passes whether or not the event was prevented — measured: it survived
    // its own mutation. This listener is registered after the app's (same
    // target, `window`, so registration order decides), and reads what the app
    // left behind.
    await page.goto("/?seed=0&mockStudioProjects=absent");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.evaluate(() => {
      const win = window as unknown as { __printKey?: boolean | null };
      win.__printKey = null;
      window.addEventListener("keydown", (event) => {
        if (!(event.metaKey || event.ctrlKey)) return;
        if (event.key.toLowerCase() !== "p") return;
        // READ AFTER DISPATCH, not during. The app re-subscribes its handler on
        // re-render, so a listener added from a spec is not reliably last and
        // reading `defaultPrevented` inline can sample before the app has acted.
        // The flag stays set on the event object once dispatch completes.
        setTimeout(() => {
          win.__printKey = event.defaultPrevented;
        }, 0);
      });
    });

    await page.getByTestId("rail-create-new").click();
    await page.getByTestId("new-agent-in-acme-app").click();
    await expect(page.getByTestId("create-agent-dialog")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+p");
    await expect(page.getByTestId("command-palette-input")).toHaveCount(0);
    await expect(page.getByTestId("create-agent-dialog")).toBeVisible();
    // Seen by the listener, and prevented by the app during dispatch.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __printKey?: boolean | null }).__printKey,
        ),
      )
      .toBe(true);
  });
});
