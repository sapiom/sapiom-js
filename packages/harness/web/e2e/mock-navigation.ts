import { expect, type Page } from "@playwright/test";

/**
 * A project whose root is also an agent has one rail row, and that row IS the
 * agent: clicking it focuses the agent.
 *
 * This helper used to be called `focusRfqAgentThroughProjectGraph`,
 * and the name was the defect's own fingerprint. The row's click used to belong to the
 * Project axis unconditionally, so it opened a dependency graph that had
 * exactly one node in it, and the only way to reach the agent was to click that
 * node. Eleven specs went the long way round, which is how a user-visible bug
 * ("I have to click that in order to see my agent") sat behind a green suite:
 * the detour had been written into the fixture's own vocabulary.
 *
 * The graph is still one click away, on the row's own map control.
 */
export async function focusRfqAgent(page: Page): Promise<void> {
  const row = page.getByTestId("workflow-rfq");
  await expect(row).toBeVisible();
  // `.workflow-item-trigger` is on the agent's button in BOTH shapes: the merged
  // project row a compatibility payload produces (where it sits beside
  // `.workspace-row-main`) and the separate child row a plan-first project renders
  // below its pinned Agent Map. Naming `.workspace-row-main` matched only the
  // first, so every spec routed through here lost the agent as soon as mock mode
  // started rendering the shipped path.
  await row.locator(".workflow-item-trigger").click();
  await expect(row).toHaveClass(/is-focused/);
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

/**
 * Open a project row's ⋮ menu.
 *
 * Every action a project row offers now lives behind one control (SAP-2982).
 * `+` and `×` used to sit on the row itself — adjacent, same size, same
 * hover-reveal — while acting on different nouns: `+` created an AGENT in the
 * project, `×` removed the PROJECT. A menu of named items has no adjacency to
 * misread, and the specs open it before acting.
 */
export async function openProjectMenu(page: Page, label: string): Promise<void> {
  await page.getByTestId(`project-menu-${label}`).click();
  await expect(page.getByTestId(`project-menu-card-${label}`)).toBeVisible();
}

/**
 * Open "Add existing agents".
 *
 * It used to be a row in the rail's nav, beside Search and Templates. There is
 * ONE create verb now — the rail header's `+` — and a nav row that also took a
 * folder read as a second one, so registering what a folder already holds moved
 * into the rail's own ⋮ settings menu. Same dialog, same question, one level
 * deeper and no longer competing with the verb.
 */
export async function openAddExistingAgents(page: Page): Promise<void> {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("add-existing-agents").click();
}

/**
 * Open the create verb's FOLDER step on a browser host.
 *
 * The header `+` no longer opens a folder dialog directly: its first step asks
 * WHERE the agent lives, offering the projects that already exist plus a way
 * out to a folder that does not. On desktop that way out is the OS folder
 * browser and no dialog opens at all (`lib/folder-step.ts`); in Playwright,
 * which is the browser host by definition, it is this dialog.
 */
export async function openFolderStep(page: Page): Promise<void> {
  await page.getByTestId("rail-create-new").click();
  await page.getByTestId("new-agent-choose-folder").click();
}
