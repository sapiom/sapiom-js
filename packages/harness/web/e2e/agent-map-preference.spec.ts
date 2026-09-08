import { expect, test } from "@playwright/test";

const url =
  "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1";
const legacyKey = "sapiom-agent-map-layout";
const settingsKey = "sapiom-mock-agent-map-layout";

for (const scenario of [
  { name: "fresh install", expected: "elk" },
  {
    name: "explicit Classic migration",
    legacy: "classic",
    expected: "classic",
  },
  {
    name: "durable preference beats old browser state",
    legacy: "classic",
    saved: "elk",
    expected: "elk",
  },
  {
    name: "invalid preferences",
    legacy: "unknown",
    saved: "unknown",
    expected: "elk",
  },
  {
    name: "temporary URL override",
    saved: "elk",
    query: "&mapLayout=classic",
    expected: "classic",
  },
]) {
  test(scenario.name, async ({ page }) => {
    await page.addInitScript(
      ({ legacyKey, settingsKey, legacy, saved }) => {
        if (legacy) localStorage.setItem(legacyKey, legacy);
        if (saved) localStorage.setItem(settingsKey, saved);
      },
      { legacyKey, settingsKey, ...scenario },
    );
    await page.goto(url + (scenario.query ?? ""));
    await page.getByTestId("project-select-acme-app").click();
    await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
      "data-layout-engine",
      scenario.expected,
    );
    await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
      "data-layout-state",
      "ready",
    );
    if (scenario.name === "explicit Classic migration") {
      await expect
        .poll(() =>
          page.evaluate((key) => localStorage.getItem(key), settingsKey),
        )
        .toBe("classic");
      expect(
        await page.evaluate((key) => localStorage.getItem(key), legacyKey),
      ).toBeNull();
    }
    if (scenario.query) {
      expect(
        await page.evaluate((key) => localStorage.getItem(key), settingsKey),
      ).toBe("elk");
      await page.goto(url);
      await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
        "data-layout-engine",
        "elk",
      );
    }
  });
}

test("remembers explicit choices across reload and serializes rapid toggles", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByTestId("project-select-acme-app").click();
  const canvas = page.getByTestId("agent-map-canvas");
  await expect(canvas).toHaveAttribute("data-layout-engine", "elk");
  for (const name of ["Classic", "Vertical", "Classic"])
    await page.getByRole("button", { name, exact: true }).click();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), settingsKey))
    .toBe("classic");
  await page.reload();
  await expect(canvas).toHaveAttribute("data-layout-engine", "classic");
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), settingsKey))
    .toBe("elk");
  await page.reload();
  await expect(canvas).toHaveAttribute("data-layout-engine", "elk");
});

test("defaults to Vertical with preference storage blocked", async ({
  page,
}) => {
  await page.addInitScript(() => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      const original = Storage.prototype[method];
      Object.defineProperty(Storage.prototype, method, {
        value(key: string, ...args: string[]) {
          if (key.includes("agent-map-layout")) throw new Error("blocked");
          return Reflect.apply(original, this, [key, ...args]);
        },
      });
    }
  });
  await page.goto(url);
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
    "data-layout-engine",
    "elk",
  );
  await page.getByRole("button", { name: "Classic", exact: true }).click();
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
    "data-layout-engine",
    "classic",
  );
});
