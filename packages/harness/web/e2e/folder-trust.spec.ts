/** Folder trust lets project hooks run unprompted, so Studio must ask before writing it, and a
 *  session must start whatever the answer (SAP-4381). */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { BLANK_PROJECT_ROOT, addProject, openNewAgentScreen } from "./mock-navigation";

interface Evidence {
  trustCalls: string[];
  createSessionCalls: Array<{ req: { cwd?: string; harness?: string } }>;
}

const evidence = (page: Page): Promise<Evidence> =>
  page.evaluate(() => {
    const state =
      (window as unknown as { __HARNESS_TEST__?: Record<string, unknown> }).__HARNESS_TEST__ ?? {};
    return {
      trustCalls: (state.trustCalls as string[]) ?? [],
      createSessionCalls: (state.createSessionCalls as Evidence["createSessionCalls"]) ?? [],
    };
  });

const sessionStarts = (page: Page): Promise<number> =>
  evidence(page).then((e) => e.createSessionCalls.length);

async function mockTrust(
  page: Page,
  hooks: { untrusted?: string[]; statusFails?: boolean; trustFailsOnce?: boolean; trustSkipsOnce?: boolean },
): Promise<void> {
  await page.addInitScript((h) => {
    Object.assign(window, {
      __MOCK_UNTRUSTED_ROOTS__: h.untrusted ?? [],
      __MOCK_TRUST_STATUS_FAIL__: h.statusFails ?? false,
      __MOCK_TRUST_FAIL_ONCE__: h.trustFailsOnce ?? false,
      __MOCK_TRUST_SKIP_ONCE__: h.trustSkipsOnce ?? false,
    });
  }, hooks);
}

async function newChatInBlankProject(page: Page): Promise<void> {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await addProject(page, BLANK_PROJECT_ROOT);
  await page.getByTestId("project-new-chat-blank-slate").click();
}

const dialog = (page: Page) => page.getByTestId("trust-folder-confirm");

test("an untrusted project asks first, and Trust folder trusts that root once", async ({ page }) => {
  await mockTrust(page, { untrusted: [BLANK_PROJECT_ROOT] });
  await newChatInBlankProject(page);

  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText("Trust this folder?");
  await expect(dialog(page)).toContainText(BLANK_PROJECT_ROOT);
  expect(await sessionStarts(page)).toBe(0);
  // The safe answer holds focus: trusting takes a deliberate click.
  await expect(dialog(page).getByRole("button", { name: "Not now" })).toBeFocused();

  await page.getByTestId("trust-folder-confirm-btn").click();

  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => sessionStarts(page)).toBe(1);
  const after = await evidence(page);
  expect(after.trustCalls).toEqual([BLANK_PROJECT_ROOT]);
  expect(after.createSessionCalls[0]!.req).toMatchObject({
    cwd: BLANK_PROJECT_ROOT,
    harness: "claude-code",
  });
});

for (const decline of ["Not now", "Escape"] as const) {
  test(`${decline} trusts nothing and still starts the session`, async ({ page }) => {
    await mockTrust(page, { untrusted: [BLANK_PROJECT_ROOT] });
    await newChatInBlankProject(page);
    await expect(dialog(page)).toBeVisible();

    if (decline === "Escape") await page.keyboard.press("Escape");
    else await dialog(page).getByRole("button", { name: "Not now" }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => sessionStarts(page)).toBe(1);
    expect((await evidence(page)).trustCalls).toEqual([]);
  });
}

test("continuing a past session in an untrusted project asks too", async ({ page }) => {
  // Continuing history creates a session too, so it must pass the same gate.
  await mockTrust(page, { untrusted: ["/Users/demo/acme-app"] });
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("rail-history").click();
  await page.getByTestId("exited-session-sess-pricing").click();
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  const before = await sessionStarts(page);

  await page.getByTestId("dead-session-continue").click();

  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText("/Users/demo/acme-app");
  expect(await sessionStarts(page)).toBe(before);
  await dialog(page).getByRole("button", { name: "Not now" }).click();
  await expect.poll(() => sessionStarts(page)).toBe(before + 1);
  expect((await evidence(page)).trustCalls).toEqual([]);
});

test("a trusted project starts without asking", async ({ page }) => {
  await mockTrust(page, {});
  await newChatInBlankProject(page);

  await expect.poll(() => sessionStarts(page)).toBe(1);
  await expect(dialog(page)).toHaveCount(0);
  expect((await evidence(page)).trustCalls).toEqual([]);
});

test("a Codex session never asks about Claude Code trust", async ({ page }) => {
  await mockTrust(page, { untrusted: [BLANK_PROJECT_ROOT] });
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openNewAgentScreen(page);
  await page.getByTestId("composer-harness-select").click();
  await page.getByTestId("composer-harness-option-codex").click();
  await page.getByTestId("composer-input").fill("Summarize the inbox every morning");
  await page.getByTestId("composer-send").click();

  await expect.poll(() => sessionStarts(page)).toBe(1);
  const after = await evidence(page);
  expect(after.createSessionCalls[0]!.req.harness).toBe("codex");
  expect(after.trustCalls).toEqual([]);
  await expect(dialog(page)).toHaveCount(0);
});

test("an unreadable trust status asks nothing, trusts nothing, and starts", async ({ page }) => {
  await mockTrust(page, { untrusted: [BLANK_PROJECT_ROOT], statusFails: true });
  await newChatInBlankProject(page);

  await expect.poll(() => sessionStarts(page)).toBe(1);
  await expect(dialog(page)).toHaveCount(0);
  expect((await evidence(page)).trustCalls).toEqual([]);
});

for (const outcome of ["fails", "is skipped"] as const) {
  test(`a trust write that ${outcome} says so and still starts the session`, async ({ page }) => {
    await mockTrust(page, {
      untrusted: [BLANK_PROJECT_ROOT],
      ...(outcome === "fails" ? { trustFailsOnce: true } : { trustSkipsOnce: true }),
    });
    await newChatInBlankProject(page);
    await page.getByTestId("trust-folder-confirm-btn").click();

    await expect(page.getByTestId("toast")).toContainText("Couldn't trust this folder.");
    await expect.poll(() => sessionStarts(page)).toBe(1);
    expect((await evidence(page)).trustCalls).toEqual([BLANK_PROJECT_ROOT]);
  });
}

test("two starts in one untrusted project share one question and one trust write", async ({ page }) => {
  await mockTrust(page, { untrusted: [BLANK_PROJECT_ROOT] });
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await addProject(page, BLANK_PROJECT_ROOT);
  // Both clicks land before the dialog's backdrop could catch the second.
  await page.evaluate(() => {
    const plus = document.querySelector<HTMLButtonElement>(
      "[data-testid='project-new-chat-blank-slate']",
    )!;
    plus.click();
    plus.click();
  });

  await expect(dialog(page)).toHaveCount(1);
  await page.getByTestId("trust-folder-confirm-btn").click();

  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => sessionStarts(page)).toBe(2);
  expect((await evidence(page)).trustCalls).toEqual([BLANK_PROJECT_ROOT]);
});
