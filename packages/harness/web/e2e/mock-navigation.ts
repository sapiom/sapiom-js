import { expect, type Page } from "@playwright/test";

/**
 * A project whose root is also an agent has one rail row. The row's primary
 * action belongs to the Project axis, so it opens the dependency graph; the
 * graph card is the agent door.
 */
export async function focusRfqAgentThroughProjectGraph(
  page: Page,
): Promise<void> {
  await page
    .getByTestId("workflow-rfq")
    .locator(".workflow-item-trigger")
    .click();
  const node = page.getByTestId("system-graph-node-local:rfq-agent");
  await expect(node).toBeVisible();
  await node.click();
}

/** Bare-project labels now open graphs, so live sessions remain reachable through the finder. */
export async function selectMockSessionFromPalette(
  page: Page,
  name: string,
): Promise<void> {
  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-filter-sessions").click();
  await page.getByTestId("command-palette-input").fill(name);
  const item = page
    .locator(".command-palette-item")
    .filter({ hasText: name })
    .first();
  await expect(item).toBeVisible();
  await item.click();
}
