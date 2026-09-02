import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const GOLDEN_PATH_REQUEST =
  "Build a research agent that finds the top ten stocks trading today. Store the research report, then give it to a marketing agent connected to TikTok that turns it into a news-format video and publishes it.";

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("agent-map-demo-input").fill(text);
  await page.getByTestId("agent-map-demo-send").click();
}

test("walks the local Agent Map proposal from empty plan through reset", async ({
  page,
}) => {
  const productRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.startsWith("/api/") ||
      pathname.startsWith("/canvas/") ||
      pathname.startsWith("/ws/")
    ) {
      productRequests.push(pathname);
    }
  });
  await page.setViewportSize({ width: 1440, height: 1714 });
  await page.goto("/?mockFixtures=agent-map");

  const demo = page.getByTestId("agent-map-demo");
  const map = page.getByTestId("agent-map-demo-map");
  await expect(demo).toBeVisible();
  await expect(page.getByTestId("agent-map-demo-rail-map")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByTestId("agent-map-demo-project-toggle"),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(map.locator('[data-testid^="agent-map-node-"]')).toHaveCount(0);
  await expect(page.getByTestId("agent-map-demo-transcript")).toContainText(
    "I’ll plan the project’s agents, responsibilities, data flow, resources, and connectors with you. What outcome do you want this project to create?",
  );
  await page.screenshot({
    path: "web/e2e/screenshots/agent-map-demo-opening.png",
    fullPage: true,
  });

  // The project label is disclosure only. It folds and restores its children;
  // the pinned map remains the selected destination when it comes back.
  await page.getByTestId("agent-map-demo-project-toggle").click();
  await expect(
    page.getByTestId("agent-map-demo-project-toggle"),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("agent-map-demo-rail-map")).toHaveCount(0);
  await page.getByTestId("agent-map-demo-project-toggle").click();
  await expect(page.getByTestId("agent-map-demo-rail-map")).toHaveAttribute(
    "aria-current",
    "page",
  );

  // Presentation chip follows the Studio composer precedent: it prefills the
  // normal chat box, then the ordinary Send action advances the script.
  await page.getByTestId("agent-map-demo-suggestion").click();
  await expect(page.getByTestId("agent-map-demo-input")).toHaveValue(
    GOLDEN_PATH_REQUEST,
  );
  await page.getByTestId("agent-map-demo-send").click();

  await expect(
    page.getByTestId("agent-map-node-market-research"),
  ).toBeVisible();
  await expect(
    page.getByTestId("agent-map-node-marketing-publisher"),
  ).toBeVisible();
  await expect(
    page.getByTestId("agent-map-node-research-database"),
  ).toBeVisible();
  await expect(page.getByTestId("agent-map-node-tiktok")).toBeVisible();
  await expect(page.getByTestId("agent-map-node-news-editor")).toHaveCount(0);
  await expect(page.getByTestId("agent-map-demo-map-status")).toContainText(
    "Proposal · rev 1",
  );
  await expect(page.getByTestId("agent-map-demo-graph")).toContainText(
    "ResearchReport",
  );
  await expect(
    page.getByTestId("agent-map-demo-proposal-card"),
  ).toHaveAttribute("data-revision", "1");

  // Regression: the board used to inherit the entire tall pane height while
  // its SVG continued to draw in a 1000×600 coordinate system. Keep cards,
  // labels, and paths inside one compact 5:3 scene instead.
  const graph = page.getByTestId("agent-map-demo-graph");
  const tallGraphGeometry = await graph.evaluate((element) => {
    const graphRect = element.getBoundingClientRect();
    const canvasRect = element.parentElement?.getBoundingClientRect();
    if (!canvasRect) throw new Error("Agent Map graph has no canvas parent");

    const cards = Array.from(
      element.querySelectorAll<HTMLElement>('[data-testid^="agent-map-node-"]'),
      (card) => {
        const rect = card.getBoundingClientRect();
        return {
          top: rect.top - graphRect.top,
          right: rect.right - graphRect.left,
          bottom: rect.bottom - graphRect.top,
          left: rect.left - graphRect.left,
        };
      },
    );

    return {
      width: graphRect.width,
      height: graphRect.height,
      canvasHeight: canvasRect.height,
      cards,
      verticalSpan:
        Math.max(...cards.map((card) => card.bottom)) -
        Math.min(...cards.map((card) => card.top)),
    };
  });

  expect(tallGraphGeometry.width / tallGraphGeometry.height).toBeCloseTo(
    5 / 3,
    2,
  );
  expect(tallGraphGeometry.height).toBeLessThan(500);
  expect(tallGraphGeometry.height).toBeLessThan(
    tallGraphGeometry.canvasHeight / 2,
  );
  expect(tallGraphGeometry.cards).toHaveLength(4);
  for (const card of tallGraphGeometry.cards) {
    expect(card.top).toBeGreaterThanOrEqual(-1);
    expect(card.left).toBeGreaterThanOrEqual(-1);
    expect(card.right).toBeLessThanOrEqual(tallGraphGeometry.width + 1);
    expect(card.bottom).toBeLessThanOrEqual(tallGraphGeometry.height + 1);
  }
  expect(tallGraphGeometry.verticalSpan).toBeLessThan(
    tallGraphGeometry.height * 0.9,
  );
  await page.screenshot({
    path: "web/e2e/screenshots/agent-map-demo-tall-proposal.png",
    fullPage: true,
  });

  await page.getByTestId("agent-map-demo-suggestion").click();
  await page.getByTestId("agent-map-demo-send").click();
  await expect(page.getByTestId("agent-map-node-news-editor")).toBeVisible();
  await expect(page.getByTestId("agent-map-node-news-editor")).toContainText(
    "Owned subagent",
  );
  await expect(page.getByTestId("agent-map-demo-map-status")).toContainText(
    "Proposal · rev 2",
  );
  await expect(
    page.getByTestId("agent-map-demo-agent-rows").getByRole("button"),
  ).toHaveCount(2);

  // Confirmation is conversational; no separate architecture button exists.
  await expect(
    page.getByRole("button", { name: /confirm architecture/i }),
  ).toHaveCount(0);
  await send(page, "yes");
  await expect(
    page.getByTestId("agent-map-demo-confirmed-revision"),
  ).toContainText("Revision 2 confirmed");
  await expect(page.getByTestId("agent-map-demo-map-status")).toContainText(
    "Confirmed · rev 2",
  );

  await send(page, "Show me the build plan.");
  await expect(page.getByTestId("agent-map-demo-build-plan")).toBeVisible();
  await expect(page.getByTestId("agent-map-demo-build-plan")).toContainText(
    "2 scoped builders",
  );
  await expect(page.getByTestId("agent-map-demo-build-plan")).toContainText(
    "Owned News Editor",
  );

  // A second conversational approval stages UI-only builder-session rows.
  await send(page, "Approve and launch the builders.");
  await expect(
    page.getByTestId("agent-map-demo-builder-market-research"),
  ).toContainText("simulated");
  await expect(
    page.getByTestId("agent-map-demo-builder-marketing-publisher"),
  ).toContainText("simulated");
  await expect(page.getByTestId("agent-map-demo-launch-summary")).toContainText(
    "nothing was created",
  );
  await expect(page.getByTestId("agent-map-demo-map-status")).toContainText(
    "Builders simulated",
  );
  await page.screenshot({
    path: "web/e2e/screenshots/agent-map-demo-builders.png",
    fullPage: true,
  });

  // Builder rows are navigation targets into deterministic session snapshots.
  // The project map remains the default surface until one is selected.
  const mapRow = page.getByTestId("agent-map-demo-rail-map");
  const researchBuilder = page.getByTestId(
    "agent-map-demo-builder-market-research",
  );
  const publisherBuilder = page.getByTestId(
    "agent-map-demo-builder-marketing-publisher",
  );
  await researchBuilder.click();
  await expect(researchBuilder).toHaveAttribute("aria-current", "page");
  await expect(mapRow).not.toHaveAttribute("aria-current", "page");
  await expect(
    page.getByTestId("agent-map-demo-builder-session"),
  ).toHaveAttribute("data-builder-session", "market-research-builder");

  const context = page.getByTestId("agent-map-demo-builder-context");
  await expect(context).toHaveAttribute("open", "");
  await expect(
    page.getByTestId("agent-map-demo-builder-context-layer-role"),
  ).toContainText("child implementation session");
  const projectContext = page.getByTestId(
    "agent-map-demo-builder-context-layer-project-context",
  );
  await expect(projectContext).toContainText("Stock video desk");
  await expect(projectContext).toContainText("Agent Map revision 2");
  await expect(projectContext).toContainText("Market Research");
  await expect(projectContext).toContainText("Marketing / Publisher");
  await expect(projectContext).toContainText("Research Database");
  await expect(projectContext).toContainText("TikTok");
  await expect(projectContext).toContainText("Persisted handoff");
  const researchAssignment = page.getByTestId(
    "agent-map-demo-builder-context-layer-assignment",
  );
  await expect(researchAssignment).toContainText(
    "finding and ranking today’s top ten stocks",
  );
  await expect(researchAssignment).toContainText(
    "evidence-backed ResearchReport",
  );
  const researchContracts = page.getByTestId(
    "agent-map-demo-builder-context-layer-contracts",
  );
  await expect(researchContracts).toContainText("ResearchReport handoff");
  await expect(researchContracts).toContainText("Research Database");
  const researchBoundaries = page.getByTestId(
    "agent-map-demo-builder-context-layer-boundaries",
  );
  await expect(researchBoundaries).toContainText("editorial selection");
  await expect(researchBoundaries).toContainText("video generation");
  await expect(researchBoundaries).toContainText("TikTok publishing");
  await expect(
    page.getByTestId("agent-map-demo-builder-context-layer-operating-rule"),
  ).toContainText("Begin by planning the implementation with the user");
  await expect(
    page.getByTestId(
      "agent-map-demo-builder-context-layer-reconciliation-rule",
    ),
  ).toContainText("proposed Agent Map revision back to the Planner");
  const provenance = page.getByTestId(
    "agent-map-demo-builder-context-layer-provenance",
  );
  await expect(provenance).toContainText(
    "Injected by Planner from confirmed Agent Map revision 2",
  );
  await expect(provenance).toContainText("not a production prompt contract");

  const builderReply = page.getByTestId("agent-map-demo-builder-first-reply");
  await expect(builderReply).toContainText("planning mode");
  await expect(builderReply).toContainText(
    "Please confirm or refine this decomposition before implementation",
  );
  const builderSteps = page.getByTestId("agent-map-demo-builder-steps");
  await expect(
    builderSteps.locator('[data-testid^="agent-map-demo-builder-step-"]'),
  ).toHaveCount(5);
  for (const label of [
    "Define ResearchReport contract",
    "Fetch today’s active market data",
    "Rank and select the top ten",
    "Compose the evidence-backed report",
    "Persist and verify the Research Database handoff",
  ]) {
    await expect(builderSteps).toContainText(label);
  }
  await expect(
    page.getByTestId("agent-map-demo-builder-composer").getByRole("textbox"),
  ).toBeDisabled();

  // A project-agent row leaves the builder snapshot, restores the global map,
  // and opens that project agent's inspector.
  await page.getByTestId("agent-map-demo-rail-agent-market-research").click();
  await expect(page.getByTestId("agent-map-demo-builder-session")).toHaveCount(
    0,
  );
  await expect(mapRow).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("agent-map-demo-inspector")).toContainText(
    "Market Research",
  );

  await publisherBuilder.click();
  await expect(publisherBuilder).toHaveAttribute("aria-current", "page");
  await expect(mapRow).not.toHaveAttribute("aria-current", "page");
  await expect(
    page.getByTestId("agent-map-demo-builder-session"),
  ).toHaveAttribute("data-builder-session", "marketing-publisher-builder");
  await expect(context).toHaveAttribute("open", "");
  const publisherAssignment = page.getByTestId(
    "agent-map-demo-builder-context-layer-assignment",
  );
  await expect(publisherAssignment).toContainText(
    "ResearchReport / EditorialBrief",
  );
  await expect(publisherAssignment).toContainText("Own News Editor");
  await expect(publisherAssignment).toContainText("publish through TikTok");
  const publisherBoundaries = page.getByTestId(
    "agent-map-demo-builder-context-layer-boundaries",
  );
  await expect(publisherBoundaries).toContainText(
    "Do not redo market research",
  );
  await expect(publisherBoundaries).toContainText(
    "upstream ranking responsibility",
  );
  await expect(
    builderSteps.locator('[data-testid^="agent-map-demo-builder-step-"]'),
  ).toHaveCount(5);
  for (const label of [
    "Read and validate ResearchReport",
    "Have owned News Editor select the strongest points",
    "Draft the news script/storyboard",
    "Generate the news-format video",
    "Publish through TikTok and report the result",
  ]) {
    await expect(builderSteps).toContainText(label);
  }
  await expect(
    builderSteps.locator('[data-step-kind="owned-subagent"]'),
  ).toContainText("News Editor");
  await expect(
    builderSteps.locator('[data-step-kind="connector-boundary"]'),
  ).toContainText("TikTok");
  await page.screenshot({
    path: "web/e2e/screenshots/agent-map-demo-builder-session.png",
    fullPage: true,
  });

  // Returning to the pinned map preserves the planner transcript and the
  // launched revision; builder navigation does not fork or reset either.
  await mapRow.click();
  await expect(mapRow).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("agent-map-demo-builder-session")).toHaveCount(
    0,
  );
  await expect(page.getByTestId("agent-map-demo-transcript")).toBeVisible();
  await expect(page.getByTestId("agent-map-demo-launch-summary")).toContainText(
    "nothing was created",
  );
  await expect(page.getByTestId("agent-map-demo-map-status")).toContainText(
    "Builders simulated",
  );
  await expect(page.getByTestId("agent-map-node-news-editor")).toBeVisible();

  // Node inspection stays inside the map while the planning transcript and
  // composer remain mounted on the left.
  await page.getByTestId("agent-map-node-market-research").click();
  const inspector = page.getByTestId("agent-map-demo-inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText("Market Research");
  await expect(inspector).toContainText("Kind");
  await expect(inspector).toContainText("Agent");
  await expect(inspector).toContainText("Purpose");
  await expect(inspector).toContainText("builder staged");
  await expect(inspector).toContainText("Relationships");
  await expect(inspector).toContainText("writes");
  await expect(page.getByTestId("agent-map-demo-transcript")).toBeVisible();
  await expect(page.getByTestId("agent-map-demo-input")).toBeVisible();
  await expect(inspector).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: "web/e2e/screenshots/agent-map-demo-inspector.png",
    fullPage: true,
  });

  await page.getByTestId("agent-map-demo-reset").click();
  await expect(
    page.getByTestId("agent-map-demo-project-toggle"),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("agent-map-demo-rail-map")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(map.locator('[data-testid^="agent-map-node-"]')).toHaveCount(0);
  await expect(page.getByTestId("agent-map-demo-inspector")).toHaveCount(0);
  await expect(
    page.locator('[data-testid^="agent-map-demo-builder-"]'),
  ).toHaveCount(0);
  await expect(page.getByTestId("agent-map-demo-turn-planner")).toHaveCount(1);
  await expect(page.getByTestId("agent-map-demo-map-status")).toContainText(
    "Empty draft",
  );
  await expect(page.getByTestId("agent-map-demo-input")).toHaveValue("");

  await page.setViewportSize({ width: 900, height: 760 });
  await expect(page.getByTestId("agent-map-demo-transcript")).toBeVisible();
  await expect(page.getByTestId("agent-map-demo-map")).toBeVisible();
  await expect(productRequests).toEqual([]);
});
