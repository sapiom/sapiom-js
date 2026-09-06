/**
 * SAP-2981 — the legacy-server create-agent compatibility flow.
 *
 * Current Studio servers return durable project summaries and route creation
 * through Agent Map planning. These specs deliberately use
 * `mockStudioProjects=absent` to protect clients connected to older servers
 * whose state payloads have no Studio project catalog.
 *
 * The defect these specs guard: every create door in the Studio ended in an
 * English sentence injected into a terminal ("call the
 * sapiom_dev_agents_scaffold tool with {…}"). The harness did not create the
 * agent, so a failed create arrived as a confused model rather than an error,
 * and "did it work?" was answered by reading a terminal.
 *
 * Two things are asserted that a count cannot see:
 *
 *   - THE ORDER. `createOrder` is one append-only list holding both halves of a
 *     create, because the criterion IS the order — the agent exists before the
 *     chat starts. Two separate call logs each say a thing happened; neither
 *     says which came first, and that is the whole claim.
 *   - THE REFUSAL, from the endpoint rather than from the field. The mock's
 *     `scaffoldAgent` runs the same shared name rule the server refuses with
 *     (`@shared/agent-name`) and the same duplicate check, so a spec that
 *     bypasses the field's own validation still meets a refusal.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { openProjectMenu } from "./mock-navigation";

const ROOT = "/Users/demo/acme-app";

/** The last prompt handed to a session, as `new-session-composer.spec.ts`
 *  reads it. */
const lastInjectText = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { lastInjectInput?: { req?: { text?: string } } };
        }
      ).__HARNESS_TEST__?.lastInjectInput?.req?.text ?? "",
  );

/** Everything the app has done to create things, in order. */
const createOrder = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      ((window as unknown as { __HARNESS_TEST__?: { createOrder?: string[] } })
        .__HARNESS_TEST__?.createOrder ?? []) as string[],
  );

test.describe("legacy-server agent creation compatibility", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0&mockStudioProjects=absent");
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
  });

  test("the menu opens a dialog that STATES the project, and starts nothing", async ({
    page,
  }) => {
    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-create-agent-acme-app").click();

    const dialog = page.getByTestId("create-agent-dialog");
    await expect(dialog).toBeVisible();
    // Stated, not chosen: you clicked that row, and the dialog spells the
    // folder out because a rail label can be widened or shared.
    await expect(page.getByTestId("create-agent-project")).toHaveText(
      "acme-app",
    );
    await expect(dialog).toContainText(ROOT);
    // There is no folder picker here — asking "where" again is the subject
    // confusion this epic removes.
    await expect(dialog.getByTestId("folder-field-input")).toHaveCount(0);

    // AND NOTHING HAS HAPPENED YET. The old handler started a pty on this
    // click; a create that begins before you have named anything is the
    // behaviour this dialog replaces.
    expect(await createOrder(page)).toEqual([]);
  });

  test("creation completes BEFORE the session starts", async ({ page }) => {
    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-create-agent-acme-app").click();
    await page.getByTestId("create-agent-name").fill("billing-bot");
    await page.getByTestId("create-agent-submit").click();

    // The row lands in the rail…
    await expect(page.getByTestId("workflow-billing-bot")).toBeVisible();
    // …and the ORDER is the criterion: scaffold first, session second, both
    // rooted where the click said.
    await expect
      .poll(async () => await createOrder(page))
      .toEqual([`scaffold:${ROOT}/billing-bot`, `session:${ROOT}`]);

    // The dialog is gone because the create succeeded, not because it was
    // dismissed.
    await expect(page.getByTestId("create-agent-dialog")).toHaveCount(0);
  });

  test("a first instruction reaches the session, and never asks for a scaffold", async ({
    page,
  }) => {
    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-create-agent-acme-app").click();
    await page.getByTestId("create-agent-name").fill("digest-bot");
    await page
      .getByTestId("create-agent-instruction")
      .fill("Summarise yesterday's incidents every morning.");
    await page.getByTestId("create-agent-submit").click();
    await expect(page.getByTestId("workflow-digest-bot")).toBeVisible();

    // The project is already on disk. An agent told to "scaffold a new project
    // in this directory" would find a non-empty folder and either refuse or
    // start over — so the prompt says the scaffold is done.
    await expect
      .poll(() => lastInjectText(page))
      .toContain("Summarise yesterday's incidents every morning.");
    const prompt = await lastInjectText(page);
    expect(prompt).toContain("has just been created");
    expect(prompt).not.toContain("sapiom_dev_agents_scaffold");
  });

  test("a duplicate name is refused by the SERVER, in the dialog, and nothing starts", async ({
    page,
  }) => {
    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-create-agent-acme-app").click();
    // `leasing` is a fixture agent in this project. The field has no opinion
    // about it — only the endpoint knows what is already there.
    await page.getByTestId("create-agent-name").fill("leasing");
    await expect(page.getByTestId("create-agent-name-error")).toHaveCount(0);
    await page.getByTestId("create-agent-submit").click();

    // The server's own sentence, not the wire shape it arrives in.
    const error = page.getByTestId("create-agent-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveText(
      "acme-app already has an agent called leasing.",
    );
    await expect(error).not.toContainText("/api/agents/scaffold");

    // The dialog stays up holding what was typed, and no session was started
    // for an agent that does not exist.
    await expect(page.getByTestId("create-agent-name")).toHaveValue("leasing");
    expect(await createOrder(page)).toEqual([]);
  });

  test("a name that is not one folder segment is refused before it is sent", async ({
    page,
  }) => {
    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-create-agent-acme-app").click();
    const name = page.getByTestId("create-agent-name");
    const submit = page.getByTestId("create-agent-submit");

    for (const bad of ["../evil", "a/b"]) {
      await name.fill(bad);
      await expect(page.getByTestId("create-agent-name-error")).toContainText(
        "one folder name",
      );
      await expect(submit).toBeDisabled();
    }
    await name.fill(".hidden");
    await expect(page.getByTestId("create-agent-name-error")).toContainText(
      "dot",
    );
    await expect(submit).toBeDisabled();

    // An empty field is not a mistake yet — it says nothing and offers nothing.
    await name.fill("");
    await expect(page.getByTestId("create-agent-name-error")).toHaveCount(0);
    await expect(submit).toBeDisabled();

    await name.fill("fine-name");
    await expect(submit).toBeEnabled();
    expect(await createOrder(page)).toEqual([]);
  });

  test("Return submits from the name field — and Return on Cancel cancels", async ({
    page,
  }) => {
    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-create-agent-acme-app").click();
    await page.getByTestId("create-agent-name").fill("returned");
    await page.getByTestId("create-agent-name").press("Enter");
    await expect(page.getByTestId("workflow-returned")).toBeVisible();

    // The dialog took Return for the whole form, so a focused Cancel took it
    // too: pressing Return on "Cancel" closed the dialog AND created the
    // agent — the opposite of what was pressed. Measured, before the guard.
    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-create-agent-acme-app").click();
    await page.getByTestId("create-agent-name").fill("cancelled");
    await page.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("create-agent-dialog")).toHaveCount(0);
    await expect(page.getByTestId("workflow-cancelled")).toHaveCount(0);
  });

  test("an empty project has no inline create action and retains its menu dialog", async ({
    page,
  }) => {
    await page.getByTestId("rail-add-project").click();
    await page
      .getByTestId("folder-field-input")
      .fill("/Users/demo/blank-slate");
    await page.getByTestId("open-project").click();
    const group = page.getByTestId("workspace-group-blank-slate");
    await expect(group).toBeVisible();
    await expect(group.getByTestId("project-empty-blank-slate")).toHaveCount(0);
    await expect(
      group.getByRole("button", {
        name: /^Create (the first |an )agent here$/,
      }),
    ).toHaveCount(0);
    await openProjectMenu(page, "blank-slate");
    await page.getByTestId("project-create-agent-blank-slate").click();

    await expect(page.getByTestId("create-agent-dialog")).toBeVisible();
    await expect(page.getByTestId("create-agent-project")).toHaveText(
      "blank-slate",
    );
    expect(await createOrder(page)).toEqual([]);
  });
});
