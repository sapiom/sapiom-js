# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web/e2e/create-verb.spec.ts >> the two verbs >> an empty project's name is the door (D36)
- Location: web/e2e/create-verb.spec.ts:195:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/?seed=0&mockStudioProjects=present", waiting until "load"

```

# Test source

```ts
  96  |     await dialog.getByTestId("folder-field-input").fill("/Users/demo/nope/not-yet");
  97  |     await expect(dialog.getByTestId("project-folder-hint")).toHaveText(
  98  |       "That folder doesn't exist yet.",
  99  |     );
  100 |     await expect(dialog.getByTestId("project-folder-continue")).toBeDisabled();
  101 | 
  102 |     await dialog.getByTestId("folder-field-input").fill(BLANK_PROJECT_ROOT);
  103 |     await expect(dialog.getByTestId("project-folder-continue")).toBeEnabled();
  104 |     await dialog.getByTestId("project-folder-continue").click();
  105 | 
  106 |     // THE DESTINATION: the screen, stating the project in both places.
  107 |     await expect(page.getByTestId("new-session-composer")).toBeVisible();
  108 |     await expect(page.getByTestId("new-agent-project")).toHaveText(
  109 |       "New agent in blank-slate",
  110 |     );
  111 |     await expect(page.getByTestId("session-project-chip")).toContainText(
  112 |       "New agent in blank-slate",
  113 |     );
  114 |     // The folder is a project in the rail, with nothing under it yet.
  115 |     await expect(page.getByTestId("project-row-blank-slate")).toBeVisible();
  116 |     // No right pane: nothing exists to project until submit.
  117 |     await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
  118 |     // AND NO SESSION (Q5): the user types first.
  119 |     expect((await evidence(page)).createSessionCalls).toEqual([]);
  120 |     await expect(page.locator(".session-tabs-list > .session-tab")).toHaveCount(0);
  121 |   });
  122 | 
  123 |   test("New project (desktop): the OS picker directly, no Studio dialog, cancel returns", async ({
  124 |     page,
  125 |   }) => {
  126 |     await installDesktopBridge(page, BLANK_PROJECT_ROOT);
  127 |     await page.goto("/?seed=0&mockStudioProjects=present");
  128 |     await expect(page.locator(".rail-workflows")).toBeVisible();
  129 | 
  130 |     await page.getByTestId("rail-new-project").click();
  131 |     // The picker was asked, with no pre-chosen parent (Q8) ...
  132 |     await expect.poll(() => chooseCalls(page)).toEqual([undefined]);
  133 |     // ... and OUR dialog never opened beside it (D29), held for a window.
  134 |     await expect(page.getByTestId("new-session-composer")).toBeVisible();
  135 |     await expect(page.getByTestId("project-folder-dialog")).toHaveCount(0);
  136 |     await expect(page.locator(".modal-start")).toHaveCount(0);
  137 |     await expect(page.getByTestId("new-agent-project")).toContainText("blank-slate");
  138 |     expect((await evidence(page)).createSessionCalls).toEqual([]);
  139 |   });
  140 | 
  141 |   test("New project (desktop): a cancelled pick changes nothing", async ({ page }) => {
  142 |     await installDesktopBridge(page, null);
  143 |     await page.goto("/?seed=0&mockStudioProjects=present");
  144 |     await expect(page.locator(".rail-workflows")).toBeVisible();
  145 |     const rows = await page.locator('[data-testid^="project-row-"]').count();
  146 | 
  147 |     await page.getByTestId("rail-new-project").click();
  148 |     await expect.poll(() => chooseCalls(page)).toHaveLength(1);
  149 |     await page.waitForTimeout(300);
  150 |     await expect(page.getByTestId("project-folder-dialog")).toHaveCount(0);
  151 |     await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  152 |     await expect(page.locator('[data-testid^="project-row-"]')).toHaveCount(rows);
  153 |     // Back where they were: the boot session is still the one on screen.
  154 |     await expect(page.getByTestId("session-context")).toHaveAttribute(
  155 |       "data-session-id",
  156 |       "sess-boot",
  157 |     );
  158 |   });
  159 | 
  160 |   test("Add project: the folder step and nothing after it", async ({ page }) => {
  161 |     await page.goto("/?seed=0&mockStudioProjects=present");
  162 |     await expect(page.locator(".rail-workflows")).toBeVisible();
  163 | 
  164 |     await page.getByTestId("rail-add-project").click();
  165 |     await expect(
  166 |       page.getByTestId("project-folder-dialog").locator(".modal-title"),
  167 |     ).toHaveText("Add project");
  168 |     await page.getByTestId("folder-field-input").fill(BLANK_PROJECT_ROOT);
  169 |     await page.getByTestId("project-folder-continue").click();
  170 | 
  171 |     await expect(page.getByTestId("project-row-blank-slate")).toBeVisible();
  172 |     // No screen, no session (§4.5, Q5). The session on screen is unchanged.
  173 |     await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  174 |     await page.waitForTimeout(300);
  175 |     expect((await evidence(page)).createSessionCalls).toEqual([]);
  176 |     await expect(page.getByText("Plan Agents", { exact: true })).toHaveCount(0);
  177 |     await expect(page.getByTestId("session-context")).toHaveAttribute(
  178 |       "data-session-id",
  179 |       "sess-boot",
  180 |     );
  181 |   });
  182 | 
  183 |   test("New agent on a project row lands on the same screen, scoped to that project", async ({
  184 |     page,
  185 |   }) => {
  186 |     await page.goto("/?seed=0&mockStudioProjects=present");
  187 |     await expect(page.locator(".rail-workflows")).toBeVisible();
  188 |     await openNewAgentInProject(page, "acme-app");
  189 |     await expect(page.getByTestId("new-agent-project")).toHaveText(
  190 |       "New agent in acme-app",
  191 |     );
  192 |     expect((await evidence(page)).createSessionCalls).toEqual([]);
  193 |   });
  194 | 
  195 |   test("an empty project's name is the door (D36)", async ({ page }) => {
> 196 |     await page.goto("/?seed=0&mockStudioProjects=present");
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  197 |     await expect(page.locator(".rail-workflows")).toBeVisible();
  198 |     await addProject(page, BLANK_PROJECT_ROOT);
  199 |     await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  200 | 
  201 |     await page.getByTestId("project-select-blank-slate").click();
  202 |     await expect(page.getByTestId("new-session-composer")).toBeVisible();
  203 |     await expect(page.getByTestId("new-agent-project")).toContainText("blank-slate");
  204 |     // Not a map with nothing drawn in it.
  205 |     await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
  206 |     expect((await evidence(page)).createSessionCalls).toEqual([]);
  207 |   });
  208 | 
  209 |   test("a fresh install shows the no-project home, and its one move is New project", async ({
  210 |     page,
  211 |   }) => {
  212 |     await page.goto("/?mockState=fresh");
  213 |     await expect(page.locator(".rail-workflows")).toBeVisible();
  214 |     await expect(page.getByTestId("no-project-home")).toBeVisible();
  215 |     await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  216 |     await page.getByTestId("home-new-project").click();
  217 |     await expect(page.getByTestId("project-folder-dialog")).toBeVisible();
  218 |   });
  219 | });
  220 | 
  221 | test.describe("intake", () => {
  222 |   test("links pasted into the box are sources; a long paste is a document", async ({
  223 |     page,
  224 |   }) => {
  225 |     await page.goto("/?seed=0&mockStudioProjects=present");
  226 |     await expect(page.locator(".rail-workflows")).toBeVisible();
  227 |     await openNewAgentScreen(page);
  228 |     const input = page.getByTestId("composer-input");
  229 |     await input.fill("Summarise these every morning.");
  230 | 
  231 |     const paste = async (text: string): Promise<void> => {
  232 |       await page.evaluate((value) => {
  233 |         const transfer = new DataTransfer();
  234 |         transfer.setData("text/plain", value);
  235 |         document.querySelector("[data-testid='composer-input']")!.dispatchEvent(
  236 |           new ClipboardEvent("paste", {
  237 |             bubbles: true,
  238 |             cancelable: true,
  239 |             clipboardData: transfer,
  240 |           }),
  241 |         );
  242 |       }, text);
  243 |     };
  244 | 
  245 |     // Only links: listed, not typed.
  246 |     await paste("https://a.example/spec\nhttps://b.example/pricing");
  247 |     await expect(page.getByTestId("composer-source")).toHaveCount(2);
  248 |     await expect(input).toHaveValue("Summarise these every morning.");
  249 |     await expect(page.getByRole("status")).toHaveText("2 links attached.");
  250 |     // A wall of text: attached, not typed.
  251 |     await paste(Array.from({ length: 40 }, (_, i) => `Requirement ${i + 1}: something.`).join("\n"));
  252 |     // The chip says what it is (the design's "Pasted document, N words"); the
  253 |     // file it rides in keeps the pasted-N.md name on the chip's title.
  254 |     await expect(page.locator(".composer-file-name")).toContainText(["Pasted document"]);
  255 |     await expect(page.getByTestId("composer-source-document")).toContainText(/\d+ words/);
  256 |     await expect(input).toHaveValue("Summarise these every morning.");
  257 |     await expect(page.getByRole("status")).toHaveText("1 file and 2 links attached.");
  258 |     // One link can be removed like a file.
  259 |     await page.getByRole("button", { name: "Remove https://b.example/pricing" }).click();
  260 |     await expect(page.getByTestId("composer-source")).toHaveCount(1);
  261 |     // Nothing has been created or started: intake is not submit.
  262 |     expect((await evidence(page)).createSessionCalls).toEqual([]);
  263 |   });
  264 | 
  265 |   test("a pasted link reaches the session with the idea; it does not die with the screen", async ({
  266 |     page,
  267 |   }) => {
  268 |     await page.goto("/?seed=0&mockStudioProjects=present");
  269 |     await expect(page.locator(".rail-workflows")).toBeVisible();
  270 |     await openNewAgentScreen(page);
  271 |     await page.getByTestId("composer-input").fill("Summarise this spec.");
  272 |     await page.evaluate(() => {
  273 |       const transfer = new DataTransfer();
  274 |       transfer.setData("text/plain", "https://a.example/spec");
  275 |       document.querySelector("[data-testid='composer-input']")!.dispatchEvent(
  276 |         new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
  277 |       );
  278 |     });
  279 |     await expect(page.getByTestId("composer-source")).toHaveCount(1);
  280 |     await page.getByTestId("composer-send").click();
  281 |     await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  282 |     const [call] = (await evidence(page)).createSessionCalls;
  283 |     expect(call?.req.initialPrompt).toBe("Summarise this spec.\nhttps://a.example/spec");
  284 |   });
  285 | });
  286 | 
```