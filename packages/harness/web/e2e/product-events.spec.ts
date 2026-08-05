/**
 * Product-analytics wiring for the agent-lifecycle metrics (agents built /
 * templates used / agents deployed).
 *
 * PostHog is disabled under mock mode (VITE_MOCK — see analytics/posthog.ts
 * `injectedConfig`), so there is no live capture to assert against. Instead
 * `analytics/events.ts` `track()` records each event on
 * `window.__HARNESS_TEST__.productEvents` when VITE_MOCK is set — the same test
 * seam `interceptMockTrack` uses for the collector `track`. These specs assert
 * the call sites fire with the right, content-free payloads.
 *
 * `agent.created` ("agents built") is NOT covered here: in mock mode no user
 * flow produces a genuinely-new `sapiom.json` (scaffold/clone are delegated to
 * the coding agent, which does not run under mock), so there is no honest way
 * to make a new workflow path appear. Its seed/dedupe logic is unit-tested in
 * analytics/lifecycle.test.ts.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

interface ProductEvent {
  event: string;
  properties?: Record<string, unknown>;
}

async function productEvents(page: Page): Promise<ProductEvent[]> {
  return page.evaluate(
    () =>
      ((window as unknown as { __HARNESS_TEST__?: { productEvents?: unknown[] } })
        .__HARNESS_TEST__?.productEvents ?? []) as ProductEvent[],
  );
}

const names = (events: ProductEvent[]): string[] => events.map((e) => e.event);

test.describe("agent-lifecycle product events → PostHog", () => {
  test("deploy fires agent.deploy_started then agent.deploy_succeeded, slug-only + duration", async ({
    page,
  }) => {
    await page.goto("/?seed=0");
    await expect(page.getByTestId("session-steps")).toBeVisible();

    await page.getByTestId("session-step-deploy").click();
    await expect(page.getByTestId("toast")).toContainText("Deployed to Sapiom.", {
      timeout: 5_000,
    });

    await expect
      .poll(async () => names(await productEvents(page)))
      .toEqual(
        expect.arrayContaining(["agent.deploy_started", "agent.deploy_succeeded"]),
      );

    const events = await productEvents(page);
    const started = events.find((e) => e.event === "agent.deploy_started");
    const succeeded = events.find((e) => e.event === "agent.deploy_succeeded");
    // The bound leasing agent's folder basename — never the absolute path.
    expect(started?.properties?.workflow_slug).toBe("leasing");
    expect(succeeded?.properties?.workflow_slug).toBe("leasing");
    expect(typeof succeeded?.properties?.duration_ms).toBe("number");

    // Honest payloads: no absolute paths, no cost anywhere.
    const json = JSON.stringify(events);
    expect(json).not.toContain("/Users/");
    expect(json).not.toContain("$");
  });

  test("using a gallery template fires agent.template_cloned with slug + surface", async ({
    page,
  }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.getByTestId("new-session-composer")).toBeVisible();
    await page.getByTestId("composer-browse-templates").click();
    await expect(page.getByTestId("templates-grid").first()).toBeVisible();

    await page.getByTestId("template-card-open-web-research-digest").click();
    await expect(page.getByTestId("template-detail")).toBeVisible();
    await page.getByTestId("template-use-btn").click();
    await page.getByTestId("template-use-confirm").click();

    await expect(page.getByTestId("session-context-title")).toContainText(
      "web-research-digest",
    );

    await expect
      .poll(async () => names(await productEvents(page)))
      .toContain("agent.template_cloned");

    const cloned = (await productEvents(page)).find(
      (e) => e.event === "agent.template_cloned",
    );
    expect(cloned?.properties?.template_slug).toBe("web-research-digest");
    expect(cloned?.properties?.surface).toBe("template_gallery");
  });
});
