import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`map metadata uses the muted monospace role in ${theme} mode`, async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1",
    );
    await expect(page.getByTestId("session-context")).toBeVisible();
    await page.getByTestId("project-select-acme-app").click();
    await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
      "data-layout-state",
      "ready",
    );
    await page
      .getByTestId("agent-map-info-node_00000000-0000-7000-8000-000000000101")
      .click();
    await expect(page.getByTestId("agent-map-inspector")).toBeVisible();
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);

    // Resolve the design roles in the browser, so this checks the cascade and
    // rem/theme resolution at each consumer rather than matching CSS source.
    const expected = await page.evaluate(() => {
      const reference = document.createElement("span");
      reference.style.cssText =
        "color:var(--text-faint);font-family:var(--font-mono);font-size:var(--type-meta)";
      document.body.append(reference);
      const style = getComputedStyle(reference);
      const result = {
        color: style.color,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
      };
      reference.remove();
      return result;
    });
    for (const selector of [
      ".agent-map-live-header .agent-map-node-meta",
      ".agent-map-node .agent-map-node-meta",
      ".agent-map-inspector .agent-map-node-meta",
    ]) {
      const metadata = page.locator(selector);
      await expect(metadata.first()).toBeVisible();
      const actual = await metadata.evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return {
            color: style.color,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
          };
        }),
      );
      for (const style of actual) expect(style).toEqual(expected);
    }
  });
}
