import { expect, type Page } from "@playwright/test";

/**
 * Navigation helpers for Project › Sessions (plans/studio-navigation/
 * flow-navigation.md). The rail lists sessions, not agents; an agent is
 * reached on its project's map, in the centre.
 */

/** The selected session, as the header states it. */
export async function activeSessionId(page: Page): Promise<string | null> {
  return page.getByTestId("session-context").getAttribute("data-session-id");
}

/** One click on a session row selects it, from anywhere in the rail. */
export async function selectSession(page: Page, id: string): Promise<void> {
  await page.getByTestId(`rail-session-select-${id}`).click();
  await expect.poll(() => activeSessionId(page)).toBe(id);
}

/** A project header's name: its Agent Map is the centre. */
export async function openProjectMap(page: Page, label: string): Promise<void> {
  await page.getByTestId(`project-select-${label}`).click();
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
}

/**
 * An agent picked on its project's map: the floating card names it
 * (flow-map-chat-overlay.md 4.2). The default mock ships no drawn map, so the
 * project's agents are cards (`map-agent-<name>`); a drawn map's node picks
 * the same way.
 */
export async function openAgentPanel(
  page: Page,
  project: string,
  agent: string,
): Promise<void> {
  await openProjectMap(page, project);
  await page.getByTestId(`map-agent-${agent}`).click();
  await expect(page.getByTestId("map-card")).toHaveAttribute("data-subject", agent);
}

/** Open agent on the card: the agent's modal over the map (4.2b), on its
 *  Canvas tab. */
export async function openAgentModal(
  page: Page,
  project: string,
  agent: string,
): Promise<void> {
  await openAgentPanel(page, project, agent);
  await page.getByTestId("map-card-open-agent").click();
  await expect(page.getByTestId("agent-modal")).toHaveAttribute("data-agent", agent);
}

/** The agent modal's Secrets tab. */
export async function openAgentSecrets(
  page: Page,
  project: string,
  agent: string,
): Promise<void> {
  await openAgentModal(page, project, agent);
  await page.getByTestId("agent-modal-tab-secrets").click();
  await expect(page.getByTestId("agent-modal-panel-secrets")).toBeVisible();
}

/** Remove from the rail: the project header's hover × opens the confirm. */
export async function openRemoveProject(page: Page, label: string): Promise<void> {
  await page.getByTestId(`workspace-group-${label}`).hover();
  await page.getByTestId(`project-remove-${label}`).click();
}

/** The finder reaches any session, including one under no open project. */
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


/** A folder that is NOTHING yet in the mock filesystem: no agent, no session,
 *  no `recentDirs` entry. The browser host's folder step lands on it. */
export const BLANK_PROJECT_ROOT = "/Users/demo/blank-slate";

/**
 * ADD PROJECT on the browser host (flow-creation.md §4.5): the header's
 * folder-plus opens the one-field folder dialog (there is no OS picker in
 * Playwright), the folder is typed, and the dialog's one action opens it as a
 * project. Nothing follows: no screen, no session.
 */
export async function addProject(page: Page, root: string): Promise<void> {
  await page.getByTestId("rail-add-project").click();
  await expect(page.getByTestId("project-folder-dialog")).toBeVisible();
  await page.getByTestId("folder-field-input").fill(root);
  await expect(page.getByTestId("project-folder-continue")).toBeEnabled();
  await page.getByTestId("project-folder-continue").click();
  await expect(page.getByTestId("project-folder-dialog")).toHaveCount(0);
}

/**
 * NEW PROJECT on the browser host (flow-creation.md §4.1): the rail's one CTA
 * runs the folder step, the folder opens as a project, and the new-agent
 * screen opens scoped to it. On desktop the OS picker replaces the dialog;
 * `folder-step.test.ts` proves that half.
 */
export async function openNewAgentScreen(
  page: Page,
  root: string = BLANK_PROJECT_ROOT,
): Promise<void> {
  await page.getByTestId("rail-new-project").click();
  await expect(page.getByTestId("project-folder-dialog")).toBeVisible();
  await page.getByTestId("folder-field-input").fill(root);
  await expect(page.getByTestId("project-folder-continue")).toBeEnabled();
  await page.getByTestId("project-folder-continue").click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
}

/**
 * NEW AGENT in a project you already have: New agent in the project view's
 * header (flow-navigation.md Q11). A project with no agents opens the same
 * screen from its name alone (D36).
 */
export async function openNewAgentInProject(
  page: Page,
  label: string,
): Promise<void> {
  await page.getByTestId(`project-select-${label}`).click();
  const composer = page.getByTestId("new-session-composer");
  const newAgent = page.getByTestId("project-map-new-agent");
  await expect(composer.or(newAgent)).toBeVisible();
  if (!(await composer.isVisible())) await newAgent.click();
  await expect(composer).toBeVisible();
  await expect(page.getByTestId("new-agent-project")).toContainText(label);
}
