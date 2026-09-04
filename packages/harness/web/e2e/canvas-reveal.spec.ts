/**
 * The canvas pane follows the ACTIVE session's board: shown whenever the
 * session has one, and (re)opened the moment a live render delivers a board —
 * even a pane the user had collapsed. This is the simple "populated ⇒ shown"
 * contract that replaced the composer-only, one-shot auto-reveal, so a resumed
 * session that builds an agent (a canvas.reload arrives), or a switch to an
 * already-populated agent, shows its board without a manual open. All mock mode.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// COMPATIBILITY PAYLOAD, said out loud.
//
// Before the mock's `studioProjects` default was flipped, EVERY spec ran on this
// payload without knowing it: `mockStudioProjects` returned undefined unless a
// spec opted in, so the whole suite exercised the retired direct-creation rail
// and never the shipped plan-first one. Pinning this file takes nothing away,
// it is the payload these tests already ran on; it only stops that being an
// accident. Their plan-first equivalents are covered in `project-axis.spec.ts`
// and `agent-map-planning.spec.ts`, not here.

// The mock bus test hook: simulate the server's canvas.reload for a session,
// the same event a finished render/build broadcasts.
const publishReload = (page: Page, sessionId: string): Promise<void> =>
  page.evaluate((id) => {
    (
      window as unknown as { __HARNESS_TEST__?: { publish?: (m: unknown) => void } }
    ).__HARNESS_TEST__?.publish?.({ type: "canvas.reload", harnessSessionId: id });
  }, sessionId);

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockStudioProjects=absent");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("a populated session shows its board on load — no manual open", async ({ page }) => {
  // sess-boot ships a board and is the active session at boot, so the pane is
  // open straight away.
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
});

test("a live render re-opens a pane the user had collapsed", async ({ page }) => {
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);

  // Fold it away to focus on the terminal.
  await page.getByTestId("right-collapse").click();
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);

  // The agent renders a board — a finished build, or any re-render. The pane
  // pops back open on its own: content, once present, is shown. This is the
  // behaviour the old composer-only, one-shot reveal missed for a resumed
  // session.
  await publishReload(page, "sess-boot");
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
});

/**
 * …but a canvas WRITE is not a canvas RESULT. Scaffolding documents — the
 * "Preparing your agent — installing dependencies" placeholder written while
 * npm runs, and the server's "Rendering agent diagram…" pending doc — land in
 * the same directory and broadcast the same reload. Revealing the pane for
 * those presented setup state as if it were the finished graph.
 *
 * The discriminator is the document itself: a real render embeds the graph
 * script that posts `sapiom-canvas:graph`; the placeholders deliberately post
 * nothing. Served here by intercepting the canvas document, so no fixture
 * session has to exist for a state that is transient by nature.
 */
const PREPARING_DOC = `<!doctype html><html><body>
  <span class="canvas-badge">preparing</span>
  <p>Preparing your agent — installing dependencies.</p>
</body></html>`;

test("a placeholder render does not open the pane — only a real graph does", async ({ page }) => {
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
  await page.getByTestId("right-collapse").click();
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);

  // The scaffold's first write: a document with no graph in it.
  await page.route("**/canvas/sess-boot/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: PREPARING_DOC }),
  );
  await publishReload(page, "sess-boot");

  // Give the iframe time to load and post anything it was going to post: the
  // assertion is the ABSENCE of a reveal, so it has to outlast the load.
  await page.waitForTimeout(750);
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);

  // Install finishes, the real render lands — now it opens, unprompted.
  await page.unroute("**/canvas/sess-boot/**");
  await publishReload(page, "sess-boot");
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
});
