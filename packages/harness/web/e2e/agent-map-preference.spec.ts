import { expect, test } from "@playwright/test";

const url =
  "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1";
const legacyKey = "sapiom-agent-map-layout";
const settingsKey = "sapiom-mock-agent-map-layout";
const saveError = "Couldn't save layout preference";

test("failed saves keep the selected view usable and recover on retry", async ({
  page,
}) => {
  await page.goto(url + "&mockError=updateSettings");
  await page.getByTestId("project-select-acme-app").click();
  await page.getByRole("button", { name: "Classic", exact: true }).click();
  await expect(page.getByText(saveError, { exact: true })).toBeVisible();
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
    "data-layout-engine",
    "classic",
  );
  await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.delete("mockError");
    history.replaceState(null, "", url);
  });
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
    "data-layout-engine",
    "elk",
  );
  await expect(page.getByText(saveError, { exact: true })).toHaveCount(0);
});

test("an older rejected save cannot show an error after a newer choice", async ({
  page,
}) => {
  await page.goto(url + "&mockError=updateSettings");
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByRole("button", { name: "Classic", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".agent-map-controls button",
      ),
    ];
    buttons.find((button) => button.textContent === "Classic")!.click();
    // Start the queued failing request before changing the fixture's response.
    await Promise.resolve();
    const url = new URL(location.href);
    url.searchParams.delete("mockError");
    history.replaceState(null, "", url);
    buttons.find((button) => button.textContent === "Vertical")!.click();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __HARNESS_TEST__?: { settingsWriteFailures?: number };
            }
          ).__HARNESS_TEST__?.settingsWriteFailures ?? 0,
      ),
    )
    .toBe(1);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), settingsKey))
    .toBe("elk");
  await expect(page.getByText(saveError, { exact: true })).toHaveCount(0);
});

test("failed background migration stays quiet and retains the earlier preference", async ({
  page,
}) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, "classic"),
    legacyKey,
  );
  await page.goto(url + "&mockError=updateSettings");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __HARNESS_TEST__?: { settingsWriteFailures?: number };
            }
          ).__HARNESS_TEST__?.settingsWriteFailures ?? 0,
      ),
    )
    .toBe(1);
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
    "data-layout-engine",
    "classic",
  );
  await expect(page.getByText(saveError, { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), legacyKey),
  ).toBe("classic");
});

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
