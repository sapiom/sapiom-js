/**
 * ONE dialog contract, asserted against every dialog that goes through it.
 *
 * Studio had eleven hand-rolled dialogs and no primitive; each re-decided
 * whether Tab could leave, where focus landed, whether the backdrop dismissed,
 * and whether the page behind it was still reachable, and they did not agree.
 * `components/Dialog.tsx` is the one shell now, so this file is written as a
 * TABLE rather than as four spec files: a dialog that dismissed differently
 * from its siblings is exactly the bug the shell exists to prevent, and only a
 * spec that runs the same assertions over all of them can see it.
 *
 * Adding a dialog to the shell means adding a row here. If the row cannot be
 * written, the dialog is not on the shell — with one stated exception:
 * `CloneAgentConfirm` is on the shell and has no row, because its only door is
 * a `sapiom://agent/<id>` deep link that mock mode has no way to open. It is
 * covered by inspection and by the shell's own rows, not by a row of its own.
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { openProjectMenu } from "./mock-navigation";

interface DialogCase {
  name: string;
  /** Opens the dialog and leaves it on screen. */
  open: (page: Page) => Promise<void>;
  /** The dialog surface. */
  surface: (page: Page) => Locator;
  /**
   * The control that opened it — focus must come back here on close.
   *
   * OMITTED where the door is a control that unmounts when it is used, which is
   * `CreateAgentDialog`: its project-row menu closes on the click that opens the
   * dialog, so there is no node left to return focus to and the honest outcome
   * is that focus falls back to the document. Asserting THAT is the point of
   * making this optional rather than dropping the case — a dialog that left
   * focus on a detached node would fail either way.
   */
  trigger?: (page: Page) => Locator;
  /**
   * The control that must hold focus the moment the dialog opens. Never the
   * header's close button: a dialog that opens on its own dismiss control
   * reads as already half-cancelled, and Enter closes it.
   */
  opensFocusedOn: (page: Page) => Locator;
  /** Something focusable on the page BEHIND the dialog, which must be inert
   *  and unreachable while it is up. */
  behind: (page: Page) => Locator;
}

const CASES: DialogCase[] = [
  {
    name: "StartDialog (Add existing agents)",
    open: async (page) => {
      await page.goto("/");
      await expect(page.locator(".rail-workflows")).toBeVisible();
      await page.getByTestId("add-existing-agents").click();
      await expect(page.locator(".modal-start")).toBeVisible();
    },
    surface: (page) => page.locator(".modal-start"),
    trigger: (page) => page.getByTestId("add-existing-agents"),
    opensFocusedOn: (page) => page.getByTestId("folder-field-input"),
    behind: (page) => page.getByTestId("rail-create-new"),
  },
  {
    name: "RemoveProjectConfirm",
    open: async (page) => {
      await page.goto("/");
      await expect(page.locator(".rail-workflows")).toBeVisible();
      await openProjectMenu(page, "acme-app");
      await page.getByTestId("project-remove-acme-app").click();
      await expect(page.getByTestId("remove-project-confirm")).toBeVisible();
    },
    surface: (page) => page.getByTestId("remove-project-confirm"),
    trigger: (page) => page.getByTestId("project-menu-acme-app"),
    // The SAFE action, on a destructive dialog: Enter keeps the project.
    opensFocusedOn: (page) => page.getByRole("button", { name: "Keep project" }),
    behind: (page) => page.getByTestId("rail-create-new"),
  },
  {
    name: "CreateAgentDialog",
    open: async (page) => {
      await page.goto("/?seed=0&mockStudioProjects=absent");
      await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
      await openProjectMenu(page, "acme-app");
      await page.getByTestId("project-create-agent-acme-app").click();
      await expect(page.getByTestId("create-agent-dialog")).toBeVisible();
    },
    surface: (page) => page.getByTestId("create-agent-dialog"),
    opensFocusedOn: (page) => page.getByTestId("create-agent-name"),
    behind: (page) => page.getByTestId("rail-create-new"),
  },
  {
    name: "EndSessionConfirm",
    open: async (page) => {
      await page.goto("/");
      await expect(page.locator(".rail-workflows")).toBeVisible();
      await page.getByTestId("session-menu").click();
      await page.getByTestId("session-end-btn").click();
      await expect(page.getByTestId("end-session-confirm")).toBeVisible();
    },
    surface: (page) => page.getByTestId("end-session-confirm"),
    trigger: (page) => page.getByTestId("session-menu"),
    // The SAFE action: Enter keeps the session.
    opensFocusedOn: (page) => page.getByRole("button", { name: "Keep session" }),
    behind: (page) => page.getByTestId("rail-create-new"),
  },
  {
    name: "TemplateUseDialog",
    open: async (page) => {
      await page.goto("/?mockState=fresh");
      await expect(page.getByTestId("new-session-composer")).toBeVisible();
      await page.getByTestId("composer-browse-templates").click();
      await expect(page.getByTestId("templates-panel")).toBeVisible();
      // Opened from the template's own detail view rather than from the card's
      // spec-sheet popover: that popover light-dismisses on the same press that
      // closes the dialog, so its button is gone by the time focus should come
      // back to it, and "restores focus to the trigger" has no subject.
      await page.getByTestId("template-card-open-hello-agent").click();
      await expect(page.getByTestId("template-detail")).toBeVisible();
      await page.getByTestId("template-use-btn").click();
      await expect(page.getByTestId("template-use-dialog")).toBeVisible();
    },
    surface: (page) => page.getByTestId("template-use-dialog"),
    trigger: (page) => page.getByTestId("template-use-btn"),
    opensFocusedOn: (page) => page.getByTestId("folder-field-input"),
    behind: (page) => page.getByTestId("template-detail-back"),
  },
];

/** Whether the element that currently has focus is inside the dialog. */
const focusIsInside = (surface: Locator): Promise<boolean> =>
  surface.evaluate((element) => element.contains(document.activeElement));

/** A short, stable description of the focused element, so a failure names WHICH
 *  control escaped rather than only reporting `false`. */
const focusedDescription = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return "none";
    const id =
      active.getAttribute("data-testid") ??
      active.getAttribute("aria-label") ??
      active.className;
    return `${active.tagName.toLowerCase()}[${id}]`;
  });

/**
 * Focus after the dialog has gone: back on the trigger where there is one, and
 * released to the document where the trigger no longer exists. Never left on a
 * control inside the dialog that just unmounted, which is what "focus was lost"
 * actually looks like.
 */
async function expectFocusRestored(
  page: Page,
  dialog: DialogCase,
): Promise<void> {
  if (dialog.trigger) {
    await expect(dialog.trigger(page)).toBeFocused();
    return;
  }
  expect(await focusedDescription(page)).toBe("body[]");
}

for (const dialog of CASES) {
  test.describe(dialog.name, () => {
    test.beforeEach(async ({ page }) => {
      await dialog.open(page);
    });

    test("opens focused on its subject, never on its own close button", async ({
      page,
    }) => {
      await expect(dialog.opensFocusedOn(page)).toBeFocused();
    });

    test("Escape dismisses it and hands focus back to what opened it", async ({
      page,
    }) => {
      await page.keyboard.press("Escape");
      await expect(dialog.surface(page)).toHaveCount(0);
      await expectFocusRestored(page, dialog);
    });

    test("a press on the backdrop dismisses it; a press inside does not", async ({
      page,
    }) => {
      // Inside first: a dialog that closed on its own content would pass a
      // backdrop-only assertion while being unusable.
      await dialog.surface(page).click({ position: { x: 6, y: 6 } });
      await expect(dialog.surface(page)).toBeVisible();

      // The panel is centred, so the backdrop's top-left corner is outside it.
      await page.locator(".modal-backdrop").click({ position: { x: 5, y: 5 } });
      await expect(dialog.surface(page)).toHaveCount(0);
    });

    test("the close control dismisses it and hands focus back", async ({
      page,
    }) => {
      await dialog.surface(page).getByRole("button", { name: "Close" }).click();
      await expect(dialog.surface(page)).toHaveCount(0);
      await expectFocusRestored(page, dialog);
    });

    test("Tab is contained: focus never leaves the dialog, forwards or back", async ({
      page,
    }) => {
      const surface = dialog.surface(page);
      // Enough presses to walk past the end of any of these dialogs and wrap
      // several times. One press would pass on a dialog with no trap at all,
      // because the first Tab out of a form field lands on the next field.
      for (let press = 0; press < 14; press += 1) {
        await page.keyboard.press("Tab");
        expect(
          await focusIsInside(surface),
          `focus left the dialog after ${press + 1} Tab presses, onto ${await focusedDescription(page)}`,
        ).toBe(true);
      }
      for (let press = 0; press < 14; press += 1) {
        await page.keyboard.press("Shift+Tab");
        expect(
          await focusIsInside(surface),
          `focus left the dialog after ${press + 1} Shift+Tab presses, onto ${await focusedDescription(page)}`,
        ).toBe(true);
      }
    });

    test("the page behind it is inert, so nothing back there takes focus", async ({
      page,
    }) => {
      const behind = dialog.behind(page);
      await expect(behind).toHaveCount(1);
      expect(
        await behind.evaluate((element) => element.closest("[inert]") !== null),
      ).toBe(true);
      // And the flag is real, not decorative: an inert subtree refuses focus
      // even when something calls focus() on it directly.
      expect(
        await behind.evaluate((element) => {
          (element as HTMLElement).focus();
          return document.activeElement === element;
        }),
      ).toBe(false);
    });

    test("the surface carries one accessible name, taken from its own heading", async ({
      page,
    }) => {
      const surface = dialog.surface(page);
      await expect(surface).toHaveAttribute("aria-modal", "true");
      const labelledBy = await surface.getAttribute("aria-labelledby");
      expect(labelledBy).toBeTruthy();
      // A hand-written aria-label beside a visible title is what drifted on
      // four of the eleven; the shell offers no way to write one.
      expect(await surface.getAttribute("aria-label")).toBeNull();
      const heading = surface.locator(`[id="${labelledBy}"]`);
      await expect(heading).toBeVisible();
      expect((await heading.textContent())?.trim()).toBeTruthy();
    });

    test("Tab belongs to whatever opened OVER it, not to this dialog", async ({
      page,
    }) => {
      // A layer that mounts AFTER this dialog is not inert — the background
      // sweep ran before it existed — and the trap is a document listener, so
      // every open dialog sees every Tab. Without a topmost-layer guard, this
      // dialog's trap preventDefaults and pulls focus onto its own first
      // control, which is behind the newer scrim: the next keystroke lands in a
      // field nobody can see.
      //
      // The command palette is the real case: App.tsx's Cmd-K handler opens it
      // over an open dialog, and it carries no `role`, so only its
      // `.modal-backdrop` identifies it as a layer at all.
      //
      // TWO presses, not ten, and the number is the claim. The guard makes this
      // dialog decline the Tab; it cannot make the palette contain focus,
      // because the palette has no trap and neither surface inerts the other.
      // Native order therefore does walk out of the palette eventually — see
      // the PR's note on App.tsx's missing dialog guard. What is asserted here
      // is the part this shell owns: it does not SEIZE the Tab.
      const surface = dialog.surface(page);
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByTestId("command-palette-input");
      await expect(palette).toBeVisible();
      // A path-shaped query is the branch where the palette does NOT handle Tab
      // itself, so nothing but the guard keeps focus out of the dialog.
      await palette.fill("/Users/demo");
      for (let press = 0; press < 2; press += 1) {
        await page.keyboard.press("Tab");
        expect(
          await focusIsInside(surface),
          `the dialog's trap seized Tab from the palette after ${press + 1} presses, onto ${await focusedDescription(page)}`,
        ).toBe(false);
      }
    });

    test("the background goes back to normal when it closes", async ({
      page,
    }) => {
      await page.keyboard.press("Escape");
      await expect(dialog.surface(page)).toHaveCount(0);
      // A dialog that leaves `inert` behind freezes the whole app, which is a
      // worse failure than never setting it.
      expect(await page.locator("[inert]").count()).toBe(0);
    });
  });
}
