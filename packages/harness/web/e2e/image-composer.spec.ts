/**
 * Mock-mode UI test for the composer image-attach feature. Runs against
 * `vite dev` with VITE_MOCK=1 (see playwright.config.ts) — no harness server.
 * MockApi.attachImage records each call on
 * window.__HARNESS_TEST__.attachImageCalls, and MOCK_HARNESSES report
 * claude-code (the boot session's harness) as imageInput:true, so the attach
 * affordance renders on the active session.
 */
import { expect, test } from "@playwright/test";

// 1×1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const pngFile = {
  name: "screenshot.png",
  mimeType: "image/png",
  buffer: Buffer.from(PNG_BASE64, "base64"),
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("no standalone attach button at idle — the queue strip only appears once something is queued", async ({ page }) => {
  // Images are attached via paste, drag-and-drop, or the hidden file input.
  // No standalone attach button renders at idle; the queue strip only appears
  // once something is queued.
  await expect(page.getByTestId("image-composer-attach")).toHaveCount(0);
  await expect(page.locator(".image-composer-bar")).toHaveCount(0);
  await page.screenshot({ path: "web/e2e/screenshots/image-composer-idle.png" });
});

test("picking an image queues a thumbnail and sending relays it to the agent", async ({ page }) => {
  await page.getByTestId("image-composer-file-input").setInputFiles(pngFile);

  // Queued: a thumbnail appears with a remove control, and a Send button.
  await expect(page.getByTestId("image-composer-thumbs").locator(".image-composer-thumb")).toHaveCount(1);
  const send = page.getByTestId("image-composer-send");
  await expect(send).toContainText("Send 1 to agent");
  await page.screenshot({ path: "web/e2e/screenshots/image-composer-queued.png" });

  await send.click();

  // The attach call fired against the active (boot) session with the PNG.
  await page.waitForFunction(
    () =>
      ((window as unknown as { __HARNESS_TEST__?: { attachImageCalls?: unknown[] } }).__HARNESS_TEST__
        ?.attachImageCalls?.length ?? 0) > 0,
  );
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __HARNESS_TEST__: { attachImageCalls: Array<{ id: string; mediaType: string }> } })
        .__HARNESS_TEST__.attachImageCalls,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].id).toBe("sess-boot");
  expect(calls[0].mediaType).toBe("image/png");

  // The queue clears after a successful send.
  await expect(page.getByTestId("image-composer-thumbs")).toHaveCount(0);
});

test("remove-before-send drops a queued image without relaying it", async ({ page }) => {
  await page.getByTestId("image-composer-file-input").setInputFiles(pngFile);
  await expect(page.getByTestId("image-composer-thumbs").locator(".image-composer-thumb")).toHaveCount(1);

  await page.getByTestId("image-composer-thumb-remove").click();

  await expect(page.getByTestId("image-composer-thumbs")).toHaveCount(0);
  await expect(page.getByTestId("image-composer-send")).toHaveCount(0);
});
