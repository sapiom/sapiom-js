import { expect, test, type Page } from "@playwright/test";

async function expectAllNodesToFit(page: Page) {
  await expect
    .poll(async () => {
      const box = await page.getByTestId("agent-map-viewport").boundingBox();
      const nodes = await page
        .locator(".agent-map-node")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              right: rect.right,
              bottom: rect.bottom,
            };
          }),
        );
      return (
        box !== null &&
        nodes.every(
          (node) =>
            node.x >= box.x - 2 &&
            node.right <= box.x + box.width + 2 &&
            node.y >= box.y - 2 &&
            node.bottom <= box.y + box.height + 2,
        )
      );
    })
    .toBe(true);
}

for (const topology of ["chain", "fan-out", "cycles", "components"]) {
  test(`100-agent ${topology} reflows and fits when relationships arrive`, async ({
    page,
  }) => {
    await open(page, "mockAgentMapGolden=1");
    await expect(page.getByTestId("agent-map-live")).toBeVisible();
    const projectId = await graph(page, 100);
    const pairs = Array.from({ length: 99 }, (_, i) => [
      topology === "fan-out" ? 0 : i,
      i + 1,
    ]).filter((_, i) => topology !== "components" || i % 5 !== 0);
    if (topology === "cycles") pairs.push([99, 0]);
    const operations = pairs.map(([from, to], i) => ({
      kind: "add-relationship",
      relationship: {
        id: id("rel", 3000 + i),
        fromNodeId: id("node", 1000 + from!),
        toNodeId: id("node", 1000 + to!),
        kind: "feeds",
        executionMode: null,
        contractRef: "output:report",
        description: "Declared input",
      },
    }));
    await publish(page, {
      type: "agent-map.proposal.changed",
      delta: {
        schemaVersion: 1,
        projectId,
        proposalId: id("proposal", 101),
        fromVersion: 2,
        version: 3,
        operationIds: operations.map((_, i) => id("operation", 3000 + i)),
        operations,
        actor: { userId: "user_mock", sessionId: "coding-session" },
        acceptedAt: new Date().toISOString(),
      },
    });
    await expect(
      page
        .getByTestId("agent-map-live")
        .getByText("Version 3", { exact: true }),
    ).toBeVisible();
    await expectAllNodesToFit(page);
    await page.screenshot({
      path: test.info().outputPath(`100-${topology}.png`),
    });
  });
}

const projectGroup = "workspace-group-acme-app";
async function open(page: Page, query: string) {
  await page.goto(
    `/?seed=0&mockFixtures=deep&mockStudioProjects=present&${query}`,
  );
  await page
    .getByTestId(projectGroup)
    .getByTestId("project-select-acme-app")
    .click();
}
async function evidence(page: Page) {
  return page.evaluate(() => {
    const data = (
      window as unknown as { __HARNESS_TEST__?: Record<string, unknown[]> }
    ).__HARNESS_TEST__;
    return {
      created: data?.createSessionCalls?.length ?? 0,
      resumed: data?.resumeSessionCalls?.length ?? 0,
      input: data?.injectInputCalls?.length ?? 0,
    };
  });
}
async function publish(page: Page, message: unknown) {
  await page.evaluate(
    (value) =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { publish?: (message: unknown) => void };
        }
      ).__HARNESS_TEST__?.publish?.(value),
    message,
  );
}
const id = (prefix: string, i: number) =>
  `${prefix}_00000000-0000-7000-8000-${String(i).padStart(12, "0")}`;
async function graph(page: Page, count: number) {
  const projectId = await page
    .getByTestId("agent-map-live")
    .getAttribute("data-project-id");
  const previousNodes = await page
    .locator(".agent-map-node")
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node.getAttribute("data-testid")!.replace("agent-map-node-", ""),
      ),
    );
  const previousEdges = await page
    .locator("[data-testid^='agent-map-edge-']")
    .evaluateAll((edges) =>
      edges.map((edge) =>
        edge.getAttribute("data-testid")!.replace("agent-map-edge-", ""),
      ),
    );
  const operations = [
    ...previousEdges.map((relationshipId) => ({
      kind: "remove-relationship",
      relationshipId,
    })),
    ...previousNodes.map((nodeId) => ({ kind: "remove-node", nodeId })),
    ...Array.from({ length: count }, (_, i) => ({
      kind: "add-node",
      node: {
        id: id("node", 1000 + i),
        kind: "agent",
        name: `Existing agent ${i + 1}`,
        purpose: "Contract responsibility",
        ownerAgentId: null,
        contractRefs: [],
      },
    })),
  ];
  await publish(page, {
    type: "agent-map.proposal.changed",
    delta: {
      schemaVersion: 1,
      projectId,
      proposalId: id("proposal", 101),
      fromVersion: 1,
      version: 2,
      operationIds: operations.map((_, i) => id("operation", 1000 + i)),
      operations,
      actor: { userId: "user_mock", sessionId: "background-initializer" },
      acceptedAt: new Date().toISOString(),
    },
  });
  await expect(page.locator(".agent-map-node")).toHaveCount(count);
  return projectId;
}

test("queued and running generation show a compact state without creating a session", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "mockMapInitialization=queued");
  const before = await evidence(page);
  await expect(page.getByTestId("agent-map-generating")).toHaveText(
    /Generating Agent Map…/,
  );
  await expect(page.locator(".agent-map-node")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("agent-map-generating")).toBeVisible();
  expect(await evidence(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test("generation failure offers explicit retry and an existing map takes precedence", async ({
  page,
}) => {
  await open(page, "mockMapInitialization=failed");
  await expect(page.getByTestId("agent-map-generation-error")).toBeVisible();
  const before = await evidence(page);
  await page.getByTestId("agent-map-generation-retry").click();
  await expect(page.getByTestId("agent-map-generating")).toBeVisible();
  expect(await evidence(page)).toEqual(before);
  await open(page, "mockMapInitialization=failed&mockAgentMapGolden=1");
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  await expect(page.getByTestId("agent-map-generation-error")).toHaveCount(0);
});

test("observes completion by another host without a local initialization event", async ({
  page,
}) => {
  await open(page, "mockMapInitialization=running");
  await expect(page.getByTestId("agent-map-generating")).toBeVisible();
  const before = await evidence(page);
  // Change the durable mock response without navigating or publishing an event.
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("mockMapInitialization", "completed");
    url.searchParams.set("mockAgentMapGolden", "1");
    window.history.replaceState(null, "", url);
  });
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  await expect(page.locator(".agent-map-node")).toHaveCount(6);
  expect(await evidence(page)).toEqual(before);
});

test("initialization journal load failures remain reloadable storage errors", async ({
  page,
}) => {
  await open(page, "mockMapInitialization=error");
  await expect(page.getByTestId("agent-map-load-error")).toBeVisible();
  await expect(page.getByTestId("agent-map-generation-retry")).toHaveCount(0);
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("mockMapInitialization", "queued");
    window.history.replaceState(null, "", url);
  });
  await page.getByTestId("agent-map-retry").click();
  await expect(page.getByTestId("agent-map-generating")).toBeVisible();
  await open(page, "mockMapInitialization=error&mockAgentMapGolden=1");
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  await expect(page.getByTestId("agent-map-load-error")).toHaveCount(0);
});

test("storage errors remain separate from generation failures", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "mockAgentMapWorkspace=error&mockMapInitialization=failed");
  await expect(page.getByTestId("agent-map-load-error")).toBeVisible();
  await expect(page.getByTestId("agent-map-generation-retry")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const count of [1, 10, 50, 100])
  test(`${count} disconnected agents fit, retain selection, and respect manual viewport changes`, async ({
    page,
  }) => {
    await open(page, "mockAgentMapGolden=1");
    await expect(page.getByTestId("agent-map-live")).toBeVisible();
    const projectId = await graph(page, count);
    const subject = page.getByTestId("agent-map-subject");
    const viewport = page.getByTestId("agent-map-viewport");
    await expect
      .poll(async () => {
        const box = await viewport.boundingBox();
        const nodes = await page
          .locator(".agent-map-node")
          .evaluateAll((elements) =>
            elements.map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                x: rect.x,
                y: rect.y,
                right: rect.right,
                bottom: rect.bottom,
              };
            }),
          );
        return (
          box !== null &&
          nodes.every(
            (node) =>
              node.x >= box.x - 2 &&
              node.right <= box.x + box.width + 2 &&
              node.y >= box.y - 2 &&
              node.bottom <= box.y + box.height + 2,
          )
        );
      })
      .toBe(true);
    await page.getByTestId(`agent-map-node-${id("node", 1000)}`).click();
    await expect(page.getByTestId("agent-map-inspector")).toBeVisible();
    const selection = page.getByTestId(`agent-map-node-${id("node", 1000)}`);
    await viewport.hover();
    await page.mouse.wheel(0, 90);
    const before = await subject.evaluate(
      (element) => (element as HTMLElement).style.transform,
    );
    const operation =
      count > 1
        ? {
            kind: "add-relationship",
            relationship: {
              id: id("rel", 1000),
              fromNodeId: id("node", 1000),
              toNodeId: id("node", 1001),
              kind: "feeds",
              executionMode: null,
              contractRef: "output:report",
              description: "Declared report input",
            },
          }
        : {
            kind: "update-node",
            nodeId: id("node", 1000),
            changes: { purpose: "Updated responsibility" },
          };
    await publish(page, {
      type: "agent-map.proposal.changed",
      delta: {
        schemaVersion: 1,
        projectId,
        proposalId: id("proposal", 101),
        fromVersion: 2,
        version: 3,
        operationIds: [id("operation", 9000)],
        operations: [operation],
        actor: { userId: "user_mock", sessionId: "coding-session" },
        acceptedAt: new Date().toISOString(),
      },
    });
    await expect(
      page
        .getByTestId("agent-map-live")
        .getByText("Version 3", { exact: true }),
    ).toBeVisible();
    expect(
      await subject.evaluate(
        (element) => (element as HTMLElement).style.transform,
      ),
    ).toBe(before);
    await expect(selection).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("agent-map-inspector")).toBeVisible();
    await page.getByRole("button", { name: "Fit Agent Map to view" }).click();
  });
