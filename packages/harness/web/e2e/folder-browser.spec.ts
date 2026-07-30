/**
 * E2E tests for the FolderBrowser component, exercised through the dialogs
 * that now use it: AddWorkspaceDialog (door 1 "Open a folder"), NewSessionModal,
 * and TemplateUseDialog.
 *
 * FolderBrowser replaces DirectoryPicker in ALL folder-browsing surfaces:
 *   + → "Open a folder" (aw-door-have) → FolderBrowser
 *   + → "New session…" → FolderBrowser
 *   Templates → "Use template" → FolderBrowser
 *
 * Runs against `vite dev --port 5299` with VITE_MOCK=1.
 */
import { expect, test } from "@playwright/test";

test.describe("FolderBrowser — new-session modal", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("new-session-btn").click();
    await expect(page.locator(".modal-new-session")).toBeVisible();
  });

  test("renders FolderBrowser, not a bare text input", async ({ page }) => {
    const modal = page.locator(".modal-new-session");
    // FolderBrowser's breadcrumbs and listing are present.
    await expect(modal.getByTestId("folder-browser-breadcrumbs")).toBeVisible();
    await expect(modal.getByTestId("folder-browser-listing")).toBeVisible();
    // The old bare text input is gone.
    await expect(modal.getByTestId("dir-picker-input")).toHaveCount(0);
  });

  test("clicking a folder item navigates into it", async ({ page }) => {
    const modal = page.locator(".modal-new-session");
    // The modal seeds from launchDir (/Users/demo/acme-app); its subfolder
    // 'leasing' should appear in the listing.
    await expect(modal.getByTestId("folder-browser-item-leasing")).toBeVisible();
    await modal.getByTestId("folder-browser-item-leasing").click();
    // Breadcrumb tail updates to reflect the drill.
    await expect(modal.getByTestId("folder-browser-crumb-leasing")).toBeVisible();
  });

  test("up button walks to parent", async ({ page }) => {
    const modal = page.locator(".modal-new-session");
    // Wait for the initial listing to resolve before clicking Up, so `parent`
    // is set correctly. acme-app has children, so we wait for the listing items.
    await expect(modal.getByTestId("folder-browser-item-leasing")).toBeVisible();
    await modal.getByTestId("folder-browser-up").click();
    // Parent of /Users/demo/acme-app is /Users/demo — rfq-workflows is its sibling.
    await expect(modal.getByTestId("folder-browser-item-rfq-workflows")).toBeVisible();
  });

  test("'or type a path' input navigates to a typed path", async ({ page }) => {
    const modal = page.locator(".modal-new-session");
    await modal.getByTestId("folder-browser-type-toggle").click();
    const typeInput = modal.getByTestId("folder-browser-type-input");
    await expect(typeInput).toBeVisible();
    await typeInput.fill("/Users/demo/rfq-workflows");
    await typeInput.press("Enter");
    await expect(modal.getByTestId("folder-browser-crumb-rfq-workflows")).toBeVisible();
  });

  test("FolderBrowser's 'Open this folder' button starts the session", async ({ page }) => {
    const modal = page.locator(".modal-new-session");
    // The primary CTA is the FolderBrowser button (also wired to submit).
    await expect(modal.getByTestId("folder-browser-open")).toBeVisible();
    await modal.getByTestId("folder-browser-open").click();
    // Modal closes and a session starts in acme-app.
    await expect(page.locator(".modal-new-session")).toHaveCount(0);
    await expect(page.getByTestId("session-context-title")).toContainText("acme-app");
  });
});

test.describe("FolderBrowser — add workspace door 1 (Open a folder)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("aw-door-have").click();
    await expect(page.locator(".modal-add-workspace")).toBeVisible();
  });

  test("renders FolderBrowser with breadcrumbs and listing", async ({ page }) => {
    const modal = page.locator(".modal-add-workspace");
    await expect(modal.getByTestId("folder-browser-breadcrumbs")).toBeVisible();
    await expect(modal.getByTestId("folder-browser-listing")).toBeVisible();
    // No bare text input from the old DirectoryPicker.
    await expect(modal.getByTestId("dir-picker-input")).toHaveCount(0);
  });

  test("favorites and recents chips navigate to their paths", async ({ page }) => {
    const modal = page.locator(".modal-add-workspace");
    // Recents are shown when recentDirs is non-empty.
    const recents = modal.getByTestId("folder-browser-recents");
    await expect(recents).toBeVisible();
  });

  test("clicking a folder then 'Open this folder' triggers detection", async ({ page }) => {
    const modal = page.locator(".modal-add-workspace");
    // Navigate to a known agent project via the type-path secondary.
    await modal.getByTestId("folder-browser-type-toggle").click();
    await modal.getByTestId("folder-browser-type-input").fill("/Users/demo/rfq-workflows");
    await modal.getByTestId("folder-browser-type-input").press("Enter");
    await modal.getByTestId("folder-browser-open").click();
    // Detection finds the agent project.
    await expect(modal.getByTestId("aw-result")).toContainText("This is an agent project", {
      timeout: 5000,
    });
  });
});

test.describe("FolderBrowser — template use dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.getByTestId("welcome-panel")).toBeVisible();
    await page.getByTestId("welcome-browse-templates").click();
    await expect(page.getByTestId("templates-panel")).toBeVisible();
    await expect(page.getByTestId("templates-grid").first()).toBeVisible();
    await page.getByTestId("template-card-open-web-research-digest").click();
    await expect(page.getByTestId("template-detail")).toBeVisible();
    await page.getByTestId("template-use-btn").click();
    await expect(page.getByTestId("template-use-dialog")).toBeVisible();
  });

  test("renders FolderBrowser inside the template use dialog", async ({ page }) => {
    const dialog = page.getByTestId("template-use-dialog");
    await expect(dialog.getByTestId("folder-browser-breadcrumbs")).toBeVisible();
    await expect(dialog.getByTestId("folder-browser-listing")).toBeVisible();
    // Old bare text input is gone.
    await expect(dialog.getByTestId("dir-picker-input")).toHaveCount(0);
  });

  test("initial dest is shown via breadcrumb tail", async ({ page }) => {
    const dialog = page.getByTestId("template-use-dialog");
    // The default dest ends with web-research-digest; it appears in the breadcrumb.
    await expect(dialog.getByTestId("folder-browser-crumb-web-research-digest")).toBeVisible();
  });

  test("'or type a path' changes the destination", async ({ page }) => {
    const dialog = page.getByTestId("template-use-dialog");
    await dialog.getByTestId("folder-browser-type-toggle").click();
    await dialog.getByTestId("folder-browser-type-input").fill("/Users/demo/my-new-project");
    await dialog.getByTestId("folder-browser-type-input").press("Enter");
    // The breadcrumb updates to the new typed path (parent resolves since leaf is new).
    await expect(dialog.getByTestId("folder-browser-crumb-demo")).toBeVisible();
  });
});
