/**
 * The unified run entry, opened from the agent modal's Run locally and Run
 * (flow-map-chat-overlay.md 4.2b, 4.4b): input collection, validation, the
 * exact payload, and the saved input.
 */
import { expect, test, type Page } from "@playwright/test";

import { openAgentModal } from "./mock-navigation";

/** The run workspace (artifact, timeline, Dashboard) and the deploy banner
 *  with its Code integration were hosted only by the Steps surface beside a
 *  bound session. The agent modal holds Canvas and Secrets (4.2b.2); neither
 *  has a home there yet. */
const NO_HOME_IN_MODAL =
  "SAP-3838: the run workspace and the deploy banner lived only in the Steps surface; the agent modal has no home for them";


type DirectAction = { action: string; req: Record<string, unknown> };
type ProductEvent = { event: string; properties?: Record<string, unknown> };

async function loadStudio(page: Page): Promise<void> {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openAgentModal(page, "acme-app", "leasing");
}

async function openLocalSheet(page: Page): Promise<void> {
  await page.getByTestId("agent-modal-run-local").click();
  await expect(page.getByRole("dialog", { name: "Run leasing" })).toBeVisible();
  await expect(
    page.getByText("Local execution", { exact: true }),
  ).toBeVisible();
}

async function openCloudSheet(page: Page): Promise<void> {
  await page.getByTestId("agent-modal-prod-run").click();
  await expect(page.getByRole("dialog", { name: "Run leasing" })).toBeVisible();
  await expect(
    page.getByText("Cloud execution", { exact: true }),
  ).toBeVisible();
}

async function directAction(page: Page): Promise<DirectAction> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __HARNESS_TEST__?: { lastDirectAction?: DirectAction };
            }
          ).__HARNESS_TEST__?.lastDirectAction,
      ),
    )
    .toBeTruthy();
  return (await page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { lastDirectAction?: DirectAction };
        }
      ).__HARNESS_TEST__?.lastDirectAction,
  ))!;
}

async function productEvents(page: Page): Promise<ProductEvent[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { productEvents?: ProductEvent[] };
        }
      ).__HARNESS_TEST__?.productEvents ?? [],
  );
}

test.beforeEach(async ({ page }) => {
  // Every test here launches or deploys from the modal's Run / Deploy verbs.
  await loadStudio(page);
});

test.describe("unified run entry", () => {
  test("defaults to Local, validates JSON, sends the exact input, and restores it", async ({
    page,
  }) => {
    await openLocalSheet(page);

    const fieldsTab = page.getByRole("tab", { name: "Fields" });
    const jsonTab = page.getByRole("tab", { name: "JSON" });
    await fieldsTab.focus();
    await fieldsTab.press("ArrowRight");
    await expect(jsonTab).toBeFocused();
    await expect(jsonTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("dialog", { name: "Run leasing" }).getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "run-sheet-json-tab",
    );
    const editor = page.locator("#run-sheet-json");
    await editor.fill('{"topic":42}');
    await page.getByTestId("run-sheet-submit").click();
    await expect(page.getByRole("alert")).toContainText(
      "Fix the highlighted input",
    );
    await expect(page.getByText(/topic must be string/i)).toBeVisible();

    await editor.fill('{"topic":"commercial leasing"}');
    await page.getByTestId("run-sheet-submit").click();
    await expect(page.getByRole("dialog", { name: "Run leasing" })).toHaveCount(0);

    const action = await directAction(page);
    expect(action).toEqual({
      action: "runLocal",
      req: {
        sourceDir: "/Users/demo/acme-app/leasing",
        input: { topic: "commercial leasing" },
      },
    });

    // The launch still binds a session until SAP-3839 and may move the
    // centre to it; the input is saved by agent path either way.
    if ((await page.getByTestId("agent-modal").count()) === 0)
      await openAgentModal(page, "acme-app", "leasing");
    await openLocalSheet(page);
    await expect(page.getByLabel(/Topic/)).toHaveValue("commercial leasing");
  });

  test("keeps an invalid saved value visible and offers a contract reset", async ({
    page,
  }) => {
    await page.evaluate(() => {
      localStorage.setItem(
        `sapiom.studio.run-input.v1:${encodeURIComponent("/Users/demo/acme-app/leasing")}`,
        JSON.stringify({
          value: { topic: 42 },
          schemaSignature: "old-contract",
        }),
      );
    });
    await openLocalSheet(page);
    await expect(
      page.getByText(/saved input no longer matches/i),
    ).toBeVisible();
    const topic = page.getByLabel(/Topic/);
    await expect(topic).toHaveValue("42");
    await expect(topic).toHaveAttribute("aria-invalid", "true");
    await expect(topic).toHaveAccessibleDescription(/topic must be string/i);
    await page.getByRole("button", { name: "Reset to defaults" }).click();
    await expect(topic).toHaveValue("indie game development");
    await expect(topic).toHaveAttribute("aria-invalid", "false");
    await expect(topic).not.toHaveAccessibleDescription(/topic must be string/i);
  });

  test("renders and submits recursive schema controls with scoped JSON fallbacks", async ({
    page,
  }) => {
    await page.evaluate(() => {
      (
        window as unknown as { __MOCK_INPUT_CONTRACT__?: unknown }
      ).__MOCK_INPUT_CONTRACT__ = {
        status: "available",
        jsonSchema: {
          type: "object",
          properties: {
            title: { type: "string", default: "Morning brief" },
            mode: { type: "string", enum: ["brief", "full"], default: "brief" },
            publish: { type: "boolean", default: false },
            delivery: {
              type: "object",
              properties: { region: { type: "string", enum: ["eu", "us"] } },
              required: ["region"],
            },
            tags: { type: "array", items: { type: "string" } },
            advanced: { anyOf: [{ type: "null" }, { type: "object" }] },
          },
          required: ["title", "mode", "publish", "delivery"],
        },
        example: {},
      };
    });
    await openLocalSheet(page);

    await expect(page.getByLabel(/title/i)).toHaveValue("Morning brief");
    await page.getByLabel(/title/i).fill("Daily brief");
    await page
      .getByRole("combobox", { name: /^mode/i })
      .selectOption({ label: "full" });
    await page
      .getByRole("combobox", { name: /^publish/i })
      .selectOption("true");
    await page
      .getByRole("combobox", { name: /^region/i })
      .selectOption({ label: "us" });

    await page.getByLabel(/Include tags/i).check();
    await page.getByRole("button", { name: "Add item" }).click();
    await page.getByLabel(/tags item 1/i).fill("weather");

    await page.getByLabel(/Include advanced/i).check();
    await page.getByLabel("advanced", { exact: true }).fill('{"threshold":3}');
    await page.getByTestId("run-sheet-submit").click();

    expect(await directAction(page)).toEqual({
      action: "runLocal",
      req: {
        sourceDir: "/Users/demo/acme-app/leasing",
        input: {
          title: "Daily brief",
          mode: "full",
          publish: true,
          delivery: { region: "us" },
          tags: ["weather"],
          advanced: { threshold: 3 },
        },
      },
    });
  });

  test("reuses the visible entry contract when extraction reports unavailable", async ({
    page,
  }) => {
    // The fallback reads `useAgentVerbs`' visible-contract map, which nothing
    // on main writes since the Steps pane went (SAP-3836); the modal's board
    // publishes its graph only to its own progress line. src/off-limits here.
    test.fixme(true, "SAP-3838: no surface publishes the visible entry contract to useAgentVerbs (use-agent-verbs.ts, SAP-3839)");
    await expect(
      page.getByTestId("agent-modal-panel-canvas").locator(".canvas-pane"),
    ).toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as {
          __MOCK_INPUT_CONTRACT_MODE__?: "unavailable";
        }
      ).__MOCK_INPUT_CONTRACT_MODE__ = "unavailable";
    });

    await openLocalSheet(page);
    await expect(page.getByLabel(/Topic/)).toHaveValue(
      "indie game development",
    );
    await expect(
      page.getByText(/couldn't load this agent's input contract/i),
    ).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Fields" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("Cloud sends the exact cloud payload", async ({
    page,
  }) => {
    await openCloudSheet(page);
    await page.getByLabel(/Topic/).fill("warehouse renewals");
    await page.getByTestId("run-sheet-submit").click();

    const action = await directAction(page);
    expect(action).toEqual({
      action: "run",
      req: { definitionId: "4821", input: { topic: "warehouse renewals" } },
    });
  });
});

test.describe("artifact-first completion", () => {
  test.fixme(true, NO_HOME_IN_MODAL);
  test("closes the sheet, streams attempts, then leads with a rendered and copyable result", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openLocalSheet(page);
    await page.getByTestId("run-sheet-submit").click();

    const workspace = page.getByTestId("run-workspace");
    await expect(workspace).toBeVisible();
    await expect(workspace.locator(".run-workspace-status")).toContainText(
      "Completed",
      { timeout: 8_000 },
    );
    const artifact = page.getByTestId("run-artifact");
    await expect(artifact).toContainText("approved");
    await expect(artifact).toContainText("true");
    await expect(
      page.getByTestId("run-timeline").getByRole("option"),
    ).toHaveCount(3);
    await expect(workspace.getByText("Open", { exact: true })).toHaveCount(0);

    await artifact.getByRole("tab", { name: "Raw" }).click();
    await expect(artifact.locator("pre")).toContainText('"approved": true');
    const copy = artifact.getByRole("button", { name: "Copy" });
    await expect(copy).toBeVisible();
    await copy.click();
  });

  test("records content-free artifact, inspection, and dashboard events", async ({
    page,
  }) => {
    await openLocalSheet(page);
    await page.getByTestId("run-sheet-submit").click();
    await expect(page.getByTestId("run-artifact")).toBeVisible({
      timeout: 8_000,
    });
    await page.getByRole("option", { name: /screen/ }).click();

    const popupPromise = page.waitForEvent("popup");
    await page
      .getByTestId("run-workspace")
      .getByRole("link", { name: "Dashboard" })
      .click();
    const popup = await popupPromise;
    await popup.close();

    await expect
      .poll(async () => (await productEvents(page)).map((item) => item.event))
      .toEqual(
        expect.arrayContaining([
          "run.artifact_viewed",
          "run.inspection_opened",
          "run.dashboard_opened",
        ]),
      );
    const events = (await productEvents(page)).filter((item) =>
      item.event.startsWith("run."),
    );
    expect(events.every((item) => item.properties?.target === "local")).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain("indie game development");
    expect(JSON.stringify(events)).not.toContain("local-");

    // Reusing the same workspace for another completed execution must report
    // the new artifact once; component-local state must not suppress it.
    await page.evaluate(() => {
      const view = {
        executionId: "exec-telemetry-next",
        status: "completed",
        output: { approved: false },
        steps: [],
      } as const;
      const win = window as unknown as {
        __MOCK_RUN_STATE__?: Record<string, unknown>;
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      };
      win.__MOCK_RUN_STATE__ = {
        ...(win.__MOCK_RUN_STATE__ ?? {}),
        [view.executionId]: view,
      };
      win.__HARNESS_TEST__.publish({
        type: "execution.started",
        harnessSessionId: "sess-boot",
        executionId: view.executionId,
        target: "local",
      });
    });
    await expect(page.getByTestId("run-artifact")).toContainText("false", {
      timeout: 8_000,
    });
    await expect
      .poll(
        async () =>
          (await productEvents(page)).filter(
            (item) => item.event === "run.artifact_viewed",
          ).length,
      )
      .toBe(2);
  });

  test("Deploy still lands in Steps and links to the Code integration", async ({
    page,
  }) => {
    await page.getByTestId("session-step-deploy").click();
    await expect(page.getByTestId("right-tab-steps")).toHaveClass(/is-active/);
    const banner = page.getByTestId("deploy-status-banner");
    await expect(banner).toHaveAttribute("data-phase", "ready", {
      timeout: 6_000,
    });
    await page.getByTestId("deploy-open-code").click();
    await expect(page.getByTestId("snippet-panel")).toBeVisible();
  });
});
