import { expect, test, type Page } from "@playwright/test";

type DirectAction = { action: string; req: Record<string, unknown> };
type ProductEvent = { event: string; properties?: Record<string, unknown> };

async function loadStudio(page: Page): Promise<void> {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("session-steps")).toBeVisible();
}

async function openLocalSheet(page: Page): Promise<void> {
  await page.getByTestId("session-step-local").click();
  await expect(page.getByRole("dialog", { name: "Run leasing" })).toBeVisible();
  await expect(page.getByText("Local execution", { exact: true })).toBeVisible();
}

async function openCloudSheet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Choose run target" }).click();
  await page.getByRole("menuitemradio", { name: /Cloud/ }).click();
  await expect(page.getByRole("dialog", { name: "Run leasing" })).toBeVisible();
  await expect(page.getByText("Cloud execution", { exact: true })).toBeVisible();
}

async function directAction(page: Page): Promise<DirectAction> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as {
            __HARNESS_TEST__?: { lastDirectAction?: DirectAction };
          }).__HARNESS_TEST__?.lastDirectAction,
      ),
    )
    .toBeTruthy();
  return (await page.evaluate(
    () =>
      (window as unknown as {
        __HARNESS_TEST__?: { lastDirectAction?: DirectAction };
      }).__HARNESS_TEST__?.lastDirectAction,
  ))!;
}

async function productEvents(page: Page): Promise<ProductEvent[]> {
  return page.evaluate(
    () =>
      ((window as unknown as {
        __HARNESS_TEST__?: { productEvents?: ProductEvent[] };
      }).__HARNESS_TEST__?.productEvents ?? []),
  );
}

test.beforeEach(async ({ page }) => {
  await loadStudio(page);
});

test.describe("unified run entry", () => {
  test("defaults to Local, validates JSON, sends the exact input, and restores it", async ({ page }) => {
    const main = page.getByTestId("session-step-local");
    await expect(main).toHaveAccessibleName("Run using Local");
    await openLocalSheet(page);

    await page.getByRole("tab", { name: "JSON" }).click();
    const editor = page.locator("#run-sheet-json");
    await editor.fill('{"topic":42}');
    await page.getByTestId("run-sheet-submit").click();
    await expect(page.getByRole("alert")).toContainText("Fix the highlighted input");
    await expect(page.getByText(/topic must be string/i)).toBeVisible();

    await editor.fill('{"topic":"commercial leasing"}');
    await page.getByTestId("run-sheet-submit").click();

    await expect(page.getByTestId("right-tab-steps")).toHaveClass(/is-active/);
    await expect(page.getByTestId("run-workspace")).toBeVisible();
    const action = await directAction(page);
    expect(action).toEqual({
      action: "runLocal",
      req: {
        sourceDir: "/Users/demo/acme-app/leasing",
        input: { topic: "commercial leasing" },
      },
    });

    await main.click();
    await expect(page.getByLabel(/Topic/)).toHaveValue("commercial leasing");
  });

  test("keeps an invalid saved value visible and offers a contract reset", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem(
        `sapiom.studio.run-input.v1:${encodeURIComponent("/Users/demo/acme-app/leasing")}`,
        JSON.stringify({ value: { topic: 42 }, schemaSignature: "old-contract" }),
      );
    });
    await openLocalSheet(page);
    await expect(page.getByText(/saved input no longer matches/i)).toBeVisible();
    await expect(page.getByLabel(/Topic/)).toHaveValue("42");
    await page.getByRole("button", { name: "Reset to defaults" }).click();
    await expect(page.getByLabel(/Topic/)).toHaveValue("indie game development");
  });

  test("reuses the visible entry contract when extraction reports unavailable", async ({ page }) => {
    await page.getByTestId("right-tab-steps").click();
    await expect(page.getByTestId("canvas-step-row-intake")).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as {
        __MOCK_INPUT_CONTRACT_MODE__?: "unavailable";
      }).__MOCK_INPUT_CONTRACT_MODE__ = "unavailable";
    });

    await openLocalSheet(page);
    await expect(page.getByLabel(/Topic/)).toHaveValue("indie game development");
    await expect(page.getByText(/couldn't load this agent's input contract/i)).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Fields" })).toHaveAttribute("aria-selected", "true");
  });

  test("lays out Local and Cloud as distinct two-line target rows", async ({ page }) => {
    await page.getByRole("button", { name: "Choose run target" }).click();
    const local = page.getByRole("menuitemradio", { name: /Local/ });
    const cloud = page.getByRole("menuitemradio", { name: /Cloud/ });
    const [localBox, cloudBox] = await Promise.all([local.boundingBox(), cloud.boundingBox()]);

    expect(localBox).not.toBeNull();
    expect(cloudBox).not.toBeNull();
    expect(localBox!.height).toBeGreaterThanOrEqual(52);
    expect(cloudBox!.height).toBeGreaterThanOrEqual(52);
    expect(localBox!.y + localBox!.height).toBeLessThanOrEqual(cloudBox!.y);
    await expect(local).toContainText("Agent code runs here with Sapiom calls stubbed");
    await expect(cloud).toContainText("Run the deployed agent with real capabilities");
  });

  test("explicit Cloud selection persists and sends the exact cloud payload", async ({ page }) => {
    await openCloudSheet(page);
    await page.getByLabel(/Topic/).fill("warehouse renewals");
    await page.getByTestId("run-sheet-submit").click();

    const action = await directAction(page);
    expect(action).toEqual({
      action: "run",
      req: { definitionId: "4821", input: { topic: "warehouse renewals" } },
    });
    await expect(page.getByTestId("run-workspace")).toContainText("Cloud");

    await page.reload();
    await expect(page.getByTestId("session-step-local")).toHaveAccessibleName("Run using Cloud");
  });

  test("an unavailable saved Cloud target falls back to Local without overwriting it", async ({ page }) => {
    const rfqPath = "/Users/demo/rfq-agent";
    await page.evaluate((path) => {
      localStorage.setItem(
        `sapiom.studio.run-target.v1:${encodeURIComponent(path)}`,
        "prod",
      );
    }, rfqPath);

    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    const main = page.getByTestId("session-step-local");
    await expect(main).toHaveAccessibleName("Run using Local");
    await page.getByRole("button", { name: "Choose run target" }).click();
    await expect(page.getByRole("menuitemradio", { name: /Cloud/ })).toBeDisabled();
    expect(
      await page.evaluate((path) =>
        localStorage.getItem(
          `sapiom.studio.run-target.v1:${encodeURIComponent(path)}`,
        ), rfqPath),
    ).toBe("prod");
  });
});

test.describe("artifact-first completion", () => {
  test("closes the sheet, streams attempts, then leads with a rendered and copyable result", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openLocalSheet(page);
    await page.getByTestId("run-sheet-submit").click();

    const workspace = page.getByTestId("run-workspace");
    await expect(workspace).toBeVisible();
    await expect(workspace.locator(".run-workspace-status")).toContainText("Completed", { timeout: 8_000 });
    const artifact = page.getByTestId("run-artifact");
    await expect(artifact).toContainText("approved");
    await expect(artifact).toContainText("true");
    await expect(page.getByTestId("run-timeline").getByRole("option")).toHaveCount(3);
    await expect(workspace.getByText("Open", { exact: true })).toHaveCount(0);

    await artifact.getByRole("tab", { name: "Raw" }).click();
    await expect(artifact.locator("pre")).toContainText('"approved": true');
    const copy = artifact.getByRole("button", { name: "Copy" });
    await expect(copy).toBeVisible();
    await copy.click();
  });

  test("records content-free artifact, inspection, and dashboard events", async ({ page }) => {
    await openLocalSheet(page);
    await page.getByTestId("run-sheet-submit").click();
    await expect(page.getByTestId("run-artifact")).toBeVisible({ timeout: 8_000 });
    await page.getByRole("option", { name: /screen/ }).click();

    const popupPromise = page.waitForEvent("popup");
    await page.getByTestId("run-workspace").getByRole("link", { name: "Dashboard" }).click();
    const popup = await popupPromise;
    await popup.close();

    await expect.poll(async () => (await productEvents(page)).map((item) => item.event)).toEqual(
      expect.arrayContaining([
        "run.artifact_viewed",
        "run.inspection_opened",
        "run.dashboard_opened",
      ]),
    );
    const events = (await productEvents(page)).filter((item) => item.event.startsWith("run."));
    expect(events.every((item) => item.properties?.target === "local")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("indie game development");
    expect(JSON.stringify(events)).not.toContain("local-");
  });

  test("Deploy still lands in Steps and links to the Code integration", async ({ page }) => {
    await page.getByTestId("session-step-deploy").click();
    await expect(page.getByTestId("right-tab-steps")).toHaveClass(/is-active/);
    const banner = page.getByTestId("deploy-status-banner");
    await expect(banner).toHaveAttribute("data-phase", "ready", { timeout: 6_000 });
    await page.getByTestId("deploy-open-code").click();
    await expect(page.getByTestId("snippet-panel")).toBeVisible();
  });
});
