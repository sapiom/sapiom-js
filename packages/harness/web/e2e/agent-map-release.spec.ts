import { expect, test } from "@playwright/test";

for (const query of ["", "&mapLayout=classic", "&mapLayout=elk"]) {
  test(`always uses ELK despite old preferences or URL overrides: ${query || "no override"}`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("sapiom-agent-map-layout", "classic");
    });
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present" +
        query,
    );
    for (let visit = 0; visit < 2; visit++) {
      // The centre's view is not persisted: a reload lands on the selected
      // session, so each visit opens the project's map again.
      if (visit) await page.reload();
      await page.getByTestId("project-select-acme-app").click();
      const canvas = page.getByTestId("agent-map-canvas");
      await expect(canvas).toHaveAttribute("data-layout-state", "ready");
      await expect(canvas).toHaveAttribute("data-layout-engine", "elk");
      await expect(
        page.getByRole("button", { name: /^(Classic|Vertical)$/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Fit Agent Map to view" }),
      ).toBeVisible();
    }
  });
}
