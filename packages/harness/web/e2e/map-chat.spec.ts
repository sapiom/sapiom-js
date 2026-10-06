/**
 * The project view: the floating card, the map chat with its hand-off, and
 * the agent modal (plans/studio-navigation/flow-map-chat-overlay.md rev 4.1
 * §4.1 to 4.3 and 4.2b, design-map-chat.md §2; ported from the mock of record,
 * design-eng `agent-studio-v2/e2e/map-chat.spec.ts`).
 *
 *  - The board keeps its width while the card rests, changes, becomes the map
 *    chat and closes (I1).
 *  - The node card is one header row: name, state, Open agent (↗), Open in
 *    Finder; then the composer, which follows the selection (4.2.1).
 *  - Enter asks the project's MAP CHAT, keyed `map:<projectId>`: not a
 *    session, never on the rail; every Enter extends it until New chat; ×
 *    keeps it; another project has its own (4.3.2, 4.3.3, I5).
 *  - The hand-off card makes a session without navigating, and its rail row
 *    pulses once; Open session navigates (4.3.6, I6). A turn that ended in a hand-off is not shown as
 *    failed.
 *  - Open in session makes a session whose first message carries the
 *    transcript, and goes to it (4.3.7).
 *  - The agent modal: Canvas and Secrets, verbs in its header, a step's small
 *    card, and closing restores the map exactly (4.2b, I9).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import { serveMapChat, type FakeMapChat } from "./map-chat-fixture";

const GOLDEN =
  "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1";
const nodeId = (n: number) =>
  `node_00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
/** The golden map's nodes: an agent (resolves to `leasing`), another agent,
 *  and a resource. */
const STOCK_RESEARCH = 101;
const MARKETING = 102;
const RESEARCH_DB = 103;

let chat: FakeMapChat;

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  chat = await serveMapChat(page);
  await page.goto(GOLDEN);
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openMap(page, "acme-app");
});

test.afterEach(async () => {
  await chat.close();
});

async function openMap(page: Page, project: string): Promise<void> {
  await page.getByTestId(`project-select-${project}`).click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
}

const card = (page: Page): Locator => page.getByTestId("map-card");
const cardInput = (page: Page): Locator =>
  page.getByTestId("map-card-composer").getByTestId("chat-input");
const chatInput = (page: Page): Locator =>
  page.getByTestId("map-chat-overlay").getByTestId("chat-input");
const questions = (page: Page): Locator =>
  page.getByTestId("map-chat-overlay").locator(".map-chat-question");
const node = (page: Page, n: number): Locator =>
  page.getByTestId(`agent-map-node-${nodeId(n)}`);

/** The board's own box: the thing that would shrink if a panel took width. */
async function boardBox(page: Page) {
  const box = await page.getByTestId("agent-map-viewport").boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/** Every session row on the rail, by id. */
const railRows = (page: Page): Promise<string[]> =>
  page
    .locator(".rail-session-row")
    .evaluateAll((rows) =>
      rows.map((row) =>
        (row.getAttribute("data-testid") ?? "").replace("rail-session-", ""),
      ),
    );

async function pick(page: Page, n: number, subject: string): Promise<void> {
  await node(page, n).click();
  await expect(card(page)).toHaveAttribute("data-subject", subject);
}

/** The map chat's reply has finished (Stop is Send again). */
async function settled(page: Page): Promise<void> {
  await expect(
    page.getByTestId("map-chat-overlay").getByTestId("chat-submit"),
  ).not.toHaveAttribute("data-pending", "true");
}

/** Ask from the card, or from the map chat when it is open, and wait for the
 *  answer to land. */
async function ask(page: Page, question: string): Promise<void> {
  const open = (await page.getByTestId("map-chat-overlay").count()) > 0;
  const input = open ? chatInput(page) : cardInput(page);
  await expect(input).toBeEditable();
  await input.fill(question);
  await input.press("Enter");
  await expect(card(page)).toHaveAttribute("data-state", "chat");
  await expect(
    questions(page).last().locator(".studio-chat-user-text"),
  ).toHaveText(question);
  await settled(page);
}

async function newRow(page: Page, before: string[]): Promise<string> {
  await expect
    .poll(async () => (await railRows(page)).filter((id) => !before.includes(id)).length)
    .toBe(1);
  return (await railRows(page)).find((id) => !before.includes(id))!;
}

const createCalls = (page: Page) =>
  page.evaluate(
    () =>
      ((window as unknown as { __HARNESS_TEST__?: { createSessionCalls?: unknown[] } })
        .__HARNESS_TEST__?.createSessionCalls ?? []) as Array<{
        req: { cwd: string; initialPrompt?: string; initialAttachments?: Array<{ kind: string; filename?: string; dataUrl?: string }> };
      }>,
  );

test("the board's width never changes: at rest, a pick, another pick, the map chat, close (I1)", async ({ page }) => {
  const atRest = await boardBox(page);
  const centre = (await page.locator(".center-pane").boundingBox())!;
  expect(Math.round(atRest.width)).toBe(Math.round(centre.width));
  await expect(card(page)).toHaveAttribute("data-state", "project");

  await pick(page, STOCK_RESEARCH, "leasing");
  await expect(card(page)).toHaveAttribute("data-state", "node");
  expect(await boardBox(page)).toEqual(atRest);

  await pick(page, RESEARCH_DB, "Research Database");
  expect(await boardBox(page)).toEqual(atRest);

  await ask(page, "What reads from it?");
  expect(await boardBox(page)).toEqual(atRest);

  await page.getByTestId("map-chat-close").click();
  await expect(card(page)).toHaveAttribute("data-state", "node");
  expect(await boardBox(page)).toEqual(atRest);
});

test("the node card is one header row with Open agent and Open in Finder; a resource has neither", async ({ page }) => {
  await expect(cardInput(page)).toHaveAttribute("placeholder", "Ask about this project");

  await pick(page, STOCK_RESEARCH, "leasing");
  await expect(cardInput(page)).toHaveAttribute("placeholder", "Ask about leasing");
  await expect(page.getByTestId("map-card-name")).toHaveText("leasing");
  await expect(page.getByTestId("map-card-state")).toHaveText("Deployed");
  const open = page.getByTestId("map-card-open-agent");
  await expect(open).toHaveAttribute("data-tooltip", "Open agent");
  // Rev 4.1: ↗ is "open this agent", the map's own node enter arrow.
  await expect(open.locator("svg.lucide-arrow-up-right")).toHaveCount(1);
  const reveal = page.getByTestId("map-card-reveal");
  expect(["Open in Finder", "Show in Explorer", "Open folder"]).toContain(
    await reveal.getAttribute("data-tooltip"),
  );
  await expect(reveal.locator("svg.lucide-folder-open")).toHaveCount(1);
  const head = card(page).locator(".map-card-head");
  await expect(head.getByTestId("map-card-open-agent")).toBeVisible();
  await expect(head.getByTestId("map-card-reveal")).toBeVisible();
  // No ⋯, no Sessions, no Change location, no Start chat (4.2.2).
  for (const gone of [
    "map-card-more",
    "map-agent-panel",
    "map-agent-change-location",
    "map-agent-start-chat",
    "map-agent-open-canvas",
  ])
    await expect(page.getByTestId(gone)).toHaveCount(0);
  await expect(card(page)).not.toContainText(/Sessions|Location|Start chat/);
  await reveal.click();
  await expect(page.getByTestId("toast")).toHaveCount(0);

  // An agent node whose folder is not on this machine: the row names it,
  // with nothing to open or reveal, and the map says why.
  await pick(page, MARKETING, "Marketing");
  await expect(card(page)).toHaveAttribute("data-kind", "agent");
  await expect(page.getByTestId("map-card-open-agent")).toHaveCount(0);
  await expect(page.getByTestId("agent-map-open-error")).toBeVisible();

  await pick(page, RESEARCH_DB, "Research Database");
  await expect(card(page)).toHaveAttribute("data-kind", "resource");
  await expect(page.getByTestId("map-card-state")).toHaveText("resource");
  await expect(cardInput(page)).toHaveAttribute("placeholder", "Ask about Research Database");
  await expect(page.getByTestId("map-card-open-agent")).toHaveCount(0);
  await expect(page.getByTestId("map-card-reveal")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveAttribute("data-state", "project");

  // A click on the empty board does the same.
  await pick(page, STOCK_RESEARCH, "leasing");
  const board = await boardBox(page);
  await page.mouse.click(board.x + 30, board.y + board.height - 30);
  await expect(card(page)).toHaveAttribute("data-state", "project");
});

test("the map chat is not a session: nothing joins the rail, and every Enter extends it (I5)", async ({ page }) => {
  const before = await railRows(page);
  const projectId = await page.getByTestId("agent-map-live").getAttribute("data-project-id");
  await pick(page, STOCK_RESEARCH, "leasing");
  await ask(page, "What does it check?");
  expect(await railRows(page)).toEqual(before);
  expect(chat.hosts()).toEqual([`map:${projectId}`]);

  const first = questions(page).first();
  await expect(first.getByTestId("chat-context-chip")).toHaveText("Asking about leasing · agent");
  await expect(first).toHaveAttribute(
    "data-prompt",
    /^Context: agent "leasing" at \/.+\/leasing\n\nWhat does it check\?$/,
  );
  await expect(page.getByTestId("map-chat-overlay").locator(".xterm, .harness-terminal")).toHaveCount(0);
  await expect(page.getByTestId("map-chat-overlay")).toContainText("Answer: What does it check?");

  // A pick mid-chat moves the chip for the next message; same conversation.
  await pick(page, RESEARCH_DB, "Research Database");
  await expect(chatInput(page)).toHaveAttribute("placeholder", "Ask about Research Database");
  await ask(page, "Who writes to it?");
  await expect(questions(page).getByTestId("chat-context-chip")).toHaveText([
    "Asking about leasing · agent",
    "Asking about Research Database · resource",
  ]);

  // × closes it and keeps it; the next Enter from the card extends it.
  await page.getByTestId("map-chat-close").click();
  await expect(card(page)).toHaveAttribute("data-state", "node");
  await ask(page, "And what does it read?");
  await expect(questions(page)).toHaveCount(3);

  // Escape closes it too, back to the card; the conversation stays.
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveAttribute("data-state", "node");

  // Leaving the project and coming back shows the card as it was left.
  await page.getByTestId("project-select-rfq-agent").click();
  await expect(page.getByTestId("agent-map-live")).toHaveCount(0);
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  await ask(page, "Still there?");
  await expect(questions(page)).toHaveCount(4);
  expect(await railRows(page)).toEqual(before);
  expect(chat.prompts(projectId!)).toHaveLength(4);
});

test("New chat starts an empty map chat, with an empty composer", async ({ page }) => {
  await ask(page, "What runs here?");
  await expect(questions(page)).toHaveCount(1);
  await chatInput(page).fill("an unsent thought");
  await page.getByTestId("map-chat-new").click();
  await expect(card(page)).toHaveAttribute("data-state", "chat");
  await expect(questions(page)).toHaveCount(0);
  await expect(page.getByTestId("map-chat-empty")).toBeVisible();
  await expect(chatInput(page)).toHaveValue("");
  expect(chat.resets()).toBe(1);
  await ask(page, "Fresh question");
  await expect(questions(page)).toHaveCount(1);
});

test("a hand-off in a new chat offers its own Start session, not the old one's", async ({ page }) => {
  await ask(page, "Add a step that logs every call");
  await page.getByTestId("chat-handoff-start").click();
  await expect(page.getByTestId("chat-handoff-open")).toBeVisible();
  await page.getByTestId("map-chat-new").click();
  await expect(questions(page)).toHaveCount(0);
  // The new conversation's first call reuses the old one's call id.
  await ask(page, "Add a step that emails the owner");
  const handoff = page.getByTestId("chat-card-handoff");
  await expect(handoff.getByTestId("chat-handoff-start")).toBeVisible();
  await expect(handoff).not.toHaveAttribute("data-session", /.+/);
});

test("a question asked while the chat connects keeps the pick it was asked about", async ({ page }) => {
  const projectId = await page.getByTestId("agent-map-live").getAttribute("data-project-id");
  chat.delayAttach(1500);
  await pick(page, STOCK_RESEARCH, "leasing");
  await cardInput(page).fill("What does it check?");
  await cardInput(page).press("Enter");
  // A different pick while the chat is still attaching.
  await pick(page, RESEARCH_DB, "Research Database");
  await expect(questions(page)).toHaveCount(1, { timeout: 8_000 });
  await settled(page);
  expect(chat.prompts(projectId!)).toEqual([
    expect.stringMatching(/^Context: agent "leasing" at .+\n\nWhat does it check\?$/),
  ]);
  await expect(questions(page).first().getByTestId("chat-context-chip")).toHaveText(
    "Asking about leasing · agent",
  );
});

test("Escape with a resource picked closes the map chat first and keeps the pick", async ({ page }) => {
  await pick(page, RESEARCH_DB, "Research Database");
  await ask(page, "Who writes to it?");
  // Focus on the map, where its own Escape would clear the pick.
  await node(page, RESEARCH_DB).focus();
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveAttribute("data-state", "node");
  await expect(card(page)).toHaveAttribute("data-subject", "Research Database");
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveAttribute("data-state", "project");
});

test("Escape in the expanded map closes the map chat and keeps the full view", async ({ page }) => {
  await page.getByTestId("canvas-expand").click();
  await expect(page.getByTestId("agent-map-frame")).toHaveClass(/is-expanded/);
  await ask(page, "What runs here?");
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveAttribute("data-state", "project");
  await expect(page.getByTestId("agent-map-frame")).toHaveClass(/is-expanded/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-map-frame")).not.toHaveClass(/is-expanded/);
});

test("an agent opened from the expanded map shows its modal; the full view is lowered", async ({ page }) => {
  await page.getByTestId("canvas-expand").click();
  await expect(page.getByTestId("agent-map-frame")).toHaveClass(/is-expanded/);
  await node(page, STOCK_RESEARCH).dblclick();
  const modal = page.getByTestId("agent-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("agent-map-frame")).not.toHaveClass(/is-expanded/);
  // On top: a click at its centre lands on the modal itself.
  const box = (await modal.boundingBox())!;
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="agent-modal"]') != null,
    { x: box.x + box.width / 2, y: box.y + 40 },
  );
  expect(hit).toBe(true);
});

test("Stop interrupts a reply that is still streaming", async ({ page }) => {
  await cardInput(page).fill("slow, take your time");
  await cardInput(page).press("Enter");
  const stop = page.getByTestId("map-chat-overlay").getByTestId("chat-submit");
  await expect(stop).toHaveAttribute("data-pending", "true");
  await expect(stop).toHaveAttribute("aria-label", "Stop");
  await stop.click();
  await settled(page);
  expect(chat.aborts()).toBe(1);
  // A Stop the user asked for is a stop, not a failure: the chat stays
  // usable without a Reconnect.
  await expect(page.getByRole("status", { name: "Assistant status" })).toHaveText("Stopped");
  await expect(page.getByTestId("map-chat-overlay").getByRole("button", { name: "Reconnect" })).toHaveCount(0);
  await ask(page, "And now a short one");
  await expect(page.getByTestId("map-chat-overlay")).toContainText("Answer: And now a short one");
});

test("the hand-off card makes a session that does not navigate; Open session does (I6)", async ({ page }) => {
  const selectedBefore = await page
    .locator('.rail-session-row[data-selected="true"]')
    .getAttribute("data-testid");
  const before = await railRows(page);
  await pick(page, STOCK_RESEARCH, "leasing");
  // Offered unprompted: change work belongs in a session (Q10).
  await ask(page, "Add a step that emails the applicant");
  const handoff = page.getByTestId("chat-card-handoff");
  await expect(handoff).toBeVisible();
  await expect(handoff.getByTestId("chat-handoff-prompt")).toContainText(
    "Task: Add a step that emails the applicant.",
  );
  // The model marked the turn failed; the card is the outcome, not a failure.
  await expect(page.getByTestId("map-chat-overlay").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Assistant status" })).toHaveText("Finished");

  await handoff.getByTestId("chat-handoff-start").click();
  await expect(handoff.getByTestId("chat-handoff-open")).toBeVisible();
  const created = await newRow(page, before);
  await expect(handoff).toHaveAttribute("data-session", created);
  // Its row pulses once, then is an ordinary row again.
  const row = page.getByTestId(`rail-session-${created}`);
  await expect(row).toHaveAttribute("data-pulse", "true");
  await expect(row).not.toHaveAttribute("data-pulse", "true", { timeout: 5_000 });
  const call = (await createCalls(page)).at(-1)!;
  expect(call.req.initialPrompt).toContain("Task: Add a step that emails the applicant.");
  // Nothing navigated: the map, its card and the rail's selection stay.
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-state", "chat");
  expect(
    await page.locator('.rail-session-row[data-selected="true"]').getAttribute("data-testid"),
  ).toBe(selectedBefore);
  // The map chat stays usable.
  await ask(page, "What else touches it?");
  await expect(questions(page)).toHaveCount(2);

  await handoff.getByTestId("chat-handoff-open").click();
  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", created);
});

test("the hand-off card is also there when a session is asked for", async ({ page }) => {
  await ask(page, "Start a session for reviewing the agents");
  await expect(page.getByTestId("chat-card-handoff")).toContainText("Session for this project");
});

test("Open in session makes a session with the transcript and goes to it, on the Terminal", async ({ page }) => {
  const before = await railRows(page);
  await pick(page, STOCK_RESEARCH, "leasing");
  await ask(page, "What does it check?");
  const open = page.getByTestId("map-chat-open-in-session");
  await expect(open).toHaveAttribute("data-tooltip", "Open in session");
  await expect(open.locator("svg.lucide-square-terminal")).toHaveCount(1);
  await open.click();

  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
  const created = await newRow(page, before);
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", created);
  await expect(page.locator(".terminal-slot .xterm")).toBeVisible();
  const call = (await createCalls(page)).at(-1)!;
  expect(call.req.initialPrompt).toContain("Asking about leasing · agent");
  const attachment = call.req.initialAttachments?.[0];
  expect(attachment?.kind).toBe("inline");
  expect(attachment?.filename).toBe("map-chat.md");
  const transcript = Buffer.from(attachment!.dataUrl!.split(",")[1]!, "base64").toString("utf8");
  expect(transcript).toContain("What does it check?");
  expect(transcript).toContain("Answer: What does it check?");
  expect(transcript).not.toContain("studio-result");

  // Back on the map, the conversation is as it was.
  await page.getByTestId("project-select-acme-app").click();
  await expect(card(page)).toHaveAttribute("data-state", "chat");
  await expect(questions(page)).toHaveCount(1);
});

test("Open agent opens a modal over the map; closing restores the pick and the map chat exactly (I9)", async ({ page }) => {
  await pick(page, STOCK_RESEARCH, "leasing");
  await ask(page, "What does it check?");
  await page.getByTestId("map-chat-close").click();
  const atRest = await boardBox(page);
  await page.getByTestId("map-card-open-agent").click();

  const modal = page.getByTestId("agent-modal");
  await expect(modal).toHaveAttribute("data-agent", "leasing");
  await expect(modal).toHaveAttribute("data-tab", "canvas");
  await expect(page.getByTestId("agent-modal-name")).toHaveText("leasing");
  await expect(page.getByTestId("agent-modal-state")).toHaveText("Deployed");
  // Canvas, Runs, Secrets (4.7.1); `</>` leads the verbs (4.7.2).
  await expect(modal.getByRole("tab")).toHaveCount(3);
  for (const verb of ["snippets", "visualize", "run-local", "prod-run", "deploy"])
    await expect(page.getByTestId(`agent-modal-${verb}`)).toBeVisible();
  await expect(page.getByTestId("agent-modal-panel-canvas").locator(".canvas-pane")).toBeVisible();
  // The rail and a margin of the map stay visible.
  const box = (await modal.boundingBox())!;
  const rail = (await page.locator(".rail-workflows").boundingBox())!;
  expect(box.x).toBeGreaterThan(rail.x + rail.width);
  expect(box.x + box.width).toBeLessThan(1440);
  // The map is still underneath, unchanged: no entered agent page.
  await expect(page.getByTestId("agent-map-live")).toBeAttached();
  expect(await boardBox(page)).toEqual(atRest);

  await page.getByTestId("agent-modal-tab-secrets").click();
  await expect(modal).toHaveAttribute("data-tab", "secrets");
  await expect(page.getByTestId("agent-modal-panel-secrets")).toBeVisible();

  // Escape returns to the map with the pick and the map chat intact.
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(card(page)).toHaveAttribute("data-state", "node");
  await expect(card(page)).toHaveAttribute("data-subject", "leasing");
  await expect(node(page, STOCK_RESEARCH)).toHaveAttribute("aria-pressed", "true");
  await ask(page, "Back again");
  await expect(questions(page)).toHaveCount(2);

  // Opened by a double click while the map chat is open; × closes it and
  // the chat is still open.
  await node(page, STOCK_RESEARCH).dblclick();
  await expect(modal).toBeVisible();
  await page.getByTestId("agent-modal-close").click();
  await expect(modal).toHaveCount(0);
  await expect(card(page)).toHaveAttribute("data-state", "chat");
  await expect(questions(page)).toHaveCount(2);

  // The scrim closes it as well.
  await page.getByTestId("map-card").getByTestId("map-chat-close").click();
  await page.getByTestId("map-card-open-agent").click();
  await expect(modal).toBeVisible();
  await page.mouse.click(box.x + 4, 10);
  await expect(modal).toHaveCount(0);
  await expect(card(page)).toHaveAttribute("data-subject", "leasing");
});

test("a step picked in the modal shows its small card, and nothing navigates", async ({ page }) => {
  await pick(page, STOCK_RESEARCH, "leasing");
  await page.getByTestId("map-card-open-agent").click();
  const modal = page.getByTestId("agent-modal");
  await expect(modal.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  // The bundled interactive board (it answers pick with node) in the same
  // frame, as canvas-inspector.spec.ts does.
  await page.evaluate(async () => {
    const html = await (await fetch("/canvas/sess-boot/index.html")).text();
    (document.querySelector(".agent-modal .canvas-iframe") as HTMLIFrameElement).srcdoc = html;
  });
  const step = modal.frameLocator(".canvas-iframe").locator('[data-node-id="intake"]');
  await expect(step).toBeVisible();
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");
  const at = (await step.boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);

  const stepCard = page.getByTestId("step-card");
  await expect(stepCard).toHaveAttribute("data-step", "intake");
  await expect(stepCard.getByTestId("step-card-title")).toHaveText("intake");
  for (const section of ["inputs", "outputs", "calls"])
    await expect(stepCard.getByTestId(`step-card-${section}`)).toBeVisible();
  await expect(stepCard.getByTestId("step-card-outputs")).toContainText("To ");
  await expect(page.getByTestId("canvas-inspector-title")).toHaveCount(0);
  await expect(page.getByTestId("canvas-steps-surface")).toHaveCount(0);
  await expect(modal).toHaveAttribute("data-agent", "leasing");

  await stepCard.getByTestId("step-card-close").click();
  await expect(stepCard).toHaveCount(0);
  await expect(modal).toBeVisible();

  // Escape unwinds one layer at a time: the step card, then the modal.
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await expect(stepCard).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(stepCard).toHaveCount(0);
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  // A pick left on the hidden Canvas tab does not hold the modal open: on
  // Secrets, one Escape closes it.
  await page.getByTestId("map-card-open-agent").click();
  await expect(modal.locator(".canvas-iframe")).toBeAttached();
  await page.evaluate(async () => {
    const html = await (await fetch("/canvas/sess-boot/index.html")).text();
    (document.querySelector(".agent-modal .canvas-iframe") as HTMLIFrameElement).srcdoc = html;
  });
  await expect(step).toBeVisible();
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");
  const again = (await step.boundingBox())!;
  await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
  await expect(stepCard).toBeVisible();
  await page.getByTestId("agent-modal-tab-secrets").click();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});

test("Deploy runs by path from the modal's header: no session is made and the modal stays", async ({ page }) => {
  const before = await railRows(page);
  await pick(page, STOCK_RESEARCH, "leasing");
  await page.getByTestId("map-card-open-agent").click();
  await page.getByTestId("agent-modal-deploy").click();
  await expect(page.getByTestId("agent-modal-progress")).toContainText(/Deploy/);
  await page.getByTestId("agent-modal-visualize").click();
  await expect(page.getByTestId("agent-modal-progress")).toContainText(/Render/);
  expect(await railRows(page)).toEqual(before);
  await expect(page.getByTestId("agent-modal")).toBeVisible();
  expect((await createCalls(page)).length).toBe(0);
});

test("each project has its own map chat", async ({ page }) => {
  const first = await page.getByTestId("agent-map-live").getAttribute("data-project-id");
  await ask(page, "Question for acme");
  await page.getByTestId("project-select-rfq-agent").click();
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
  // rfq-agent's card is at rest, not acme-app's chat.
  await expect(card(page)).toHaveAttribute("data-state", "project");
  await expect(card(page)).toHaveAttribute("data-subject", "rfq-agent");
  await ask(page, "Question for rfq");
  await expect(questions(page)).toHaveCount(1);
  await expect(questions(page).first()).toContainText("Question for rfq");
  const hosts = chat.hosts();
  expect(hosts).toHaveLength(2);
  expect(hosts).toContain(`map:${first}`);
  expect(chat.prompts(first!)).toHaveLength(1);
});

/** The server's `assistant.state` push, as the host sends it on any change. */
async function pushAccess(page: Page, enabled: boolean, revision: number) {
  await page.evaluate(
    ([enabled, revision]) =>
      (window as any).__HARNESS_TEST__.publish({
        type: "assistant.state",
        snapshot: {
          hostInstanceId: "mock-host",
          authorityRevision: "map-chat",
          revision,
          enabled,
          sessions: [],
        },
      }),
    [enabled, revision] as const,
  );
}

test("the card follows the server's access push: off at cold start, on when the check lands", async ({ page }) => {
  // A cold start: the host has not finished its first check yet.
  await pushAccess(page, false, 1);
  await expect(card(page)).toHaveCount(0);
  await pushAccess(page, true, 2);
  await expect(cardInput(page)).toBeVisible();
  await node(page, STOCK_RESEARCH).click();
  await expect(cardInput(page)).toBeVisible();
});
