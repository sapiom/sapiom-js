import { chromium } from "@playwright/test";
const URL = process.argv[2];
const OUT = "/tmp/shots-2982";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const out = {};
await p.goto(URL, { waitUntil: "networkidle" });
await p.waitForTimeout(3500);

// The explainer is up on first run — check its focus does not draw a ring.
out.activeOnOpen = await p.evaluate(() => {
  const a = document.activeElement;
  return { tag: a?.tagName, cls: a?.className, outline: a ? getComputedStyle(a).outlineWidth : null };
});
await p.locator("[data-testid=help-overlay-dismiss]").click();
await p.waitForTimeout(400);

const LABEL = "team-bots";
const group = p.locator(`[data-testid='workspace-group-${LABEL}']`);
const row = group.locator(":scope > .workspace-row");
const trigger = p.locator(`[data-testid='project-menu-${LABEL}']`);

// 1. Hover-reveal, and the standing state at rest.
const op = (l) => l.evaluate((e) => getComputedStyle(e).opacity);
await p.mouse.move(0, 0);
await p.waitForTimeout(400);
out.restOpacity = await op(trigger);
await row.hover();
await p.waitForTimeout(400);
out.hoverOpacity = await op(trigger);

// 2. An OPEN menu holds the trigger visible with the pointer elsewhere.
await trigger.click();
await p.waitForTimeout(400);
await p.mouse.move(1200, 800);
await p.waitForTimeout(500);
out.openAwayOpacity = await op(trigger);
out.menuVisible = await p.locator(`[data-testid='project-menu-card-${LABEL}']`).isVisible();

// 3. The destructive item's hover: a wash, never full brand, never transparent.
const danger = p.locator(`[data-testid='project-remove-${LABEL}']`);
out.dangerRest = await danger.evaluate((e) => getComputedStyle(e).backgroundColor);
await danger.hover();
await p.waitForTimeout(400);
out.dangerHover = await danger.evaluate((e) => ({
  bg: getComputedStyle(e).backgroundColor,
  color: getComputedStyle(e).color,
}));
await p.screenshot({ path: `${OUT}/after-row-menu-danger.png`, clip: { x: 0, y: 250, width: 700, height: 260 } });
await p.keyboard.press("Escape");
await p.waitForTimeout(400);
out.focusReturned = await p.evaluate(() => document.activeElement?.getAttribute("data-testid"));

// 4. Keyboard: the trigger reveals itself on focus.
await p.mouse.move(0, 0);
await p.waitForTimeout(300);
await trigger.focus();
await p.waitForTimeout(300);
out.focusOpacity = await op(trigger);

// 5. A COLLAPSED row must not grow a standing ⋮.
await p.locator(`[data-testid='project-disclosure-${LABEL}']`).click();
await p.waitForTimeout(400);
out.collapsedClass = await row.getAttribute("class");
await p.mouse.move(1200, 800);
await p.waitForTimeout(500);
out.collapsedRestOpacity = await op(trigger);
await p.locator(`[data-testid='project-disclosure-${LABEL}']`).click();
await p.waitForTimeout(400);

// 6. Dark mode.
await p.locator("[data-testid=brand-identity]").click();
await p.waitForTimeout(300);
await p.locator("[data-testid=theme-toggle]").click();
await p.waitForTimeout(700);
await row.hover();
await trigger.click();
await p.waitForTimeout(500);
await p.screenshot({ path: `${OUT}/after-row-menu-dark.png`, clip: { x: 0, y: 250, width: 700, height: 260 } });
await p.keyboard.press("Escape");
await p.locator("[data-testid=brand-identity]").click();
await p.waitForTimeout(300);
await p.locator("[data-testid=rail-help]").click();
await p.waitForTimeout(700);
await p.screenshot({ path: `${OUT}/after-explainer-dark.png` });
out.darkNote = await p.locator("[data-testid=help-upgrade-note]").evaluate((e) => ({
  bg: getComputedStyle(e).backgroundColor,
  color: getComputedStyle(e).color,
}));
await p.keyboard.press("Escape");

console.log(JSON.stringify(out, null, 2));
await b.close();
