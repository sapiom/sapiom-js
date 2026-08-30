import { chromium } from "@playwright/test";

const URL = process.argv[2];
const TAG = process.argv[3] || "before";
const OUT = "/tmp/shots-2982";

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await p.goto(URL, { waitUntil: "networkidle" });
await p.waitForTimeout(4000);

const report = {};

// Is the explainer up?
report.helpOverlay = await p.locator("[data-testid=help-overlay]").count();
if (report.helpOverlay) {
  await p.screenshot({ path: `${OUT}/${TAG}-explainer.png` });
  report.helpText = await p.locator("[data-testid=help-overlay] .overview-modal-card").innerText();
  await p.locator("[data-testid=help-overlay-dismiss]").click();
  await p.waitForTimeout(400);
}

report.projects = await p.$$eval("[data-testid^='workspace-group-']", (els) =>
  els.map((e) => e.getAttribute("data-testid")),
);

const LABEL = "team-bots";
const group = p.locator(`[data-testid='workspace-group-${LABEL}']`);
const row = group.locator(":scope > .workspace-row");
await row.scrollIntoViewIfNeeded();
await row.hover();
await p.waitForTimeout(500);

report.trailing = await row.evaluate((el) =>
  Array.from(el.querySelectorAll(".workspace-row-action")).map((b) => {
    const r = b.getBoundingClientRect();
    return {
      testid: b.getAttribute("data-testid"),
      ariaLabel: b.getAttribute("aria-label"),
      tooltip: b.getAttribute("data-tooltip"),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y),
      opacity: getComputedStyle(b).opacity,
    };
  }),
);

// The rail's own width, and whether the row overflows it.
report.geometry = await p.evaluate(() => {
  const rail = document.querySelector(".rail-workflows") || document.querySelector("aside");
  const rr = rail.getBoundingClientRect();
  const rows = Array.from(document.querySelectorAll(".workspace-row"));
  const over = rows
    .map((r) => ({ t: r.getAttribute("data-testid"), right: Math.round(r.getBoundingClientRect().right), sw: r.scrollWidth, cw: r.clientWidth }))
    .filter((r) => r.sw > r.cw + 1 || r.right > rr.right + 1);
  return { railWidth: Math.round(rr.width), railRight: Math.round(rr.right), overflowing: over.slice(0, 8) };
});

// Row crop, hovered.
const box = await row.boundingBox();
await p.screenshot({
  path: `${OUT}/${TAG}-row-hover.png`,
  clip: { x: box.x - 4, y: box.y - 26, width: Math.min(340, box.width + 8), height: box.height + 52 },
});
await p.screenshot({ path: `${OUT}/${TAG}-rail.png`, clip: { x: 0, y: 0, width: 320, height: 950 } });

// If a menu exists, open it and shoot it.
const menu = p.locator(`[data-testid='project-menu-${LABEL}']`);
if (await menu.count()) {
  await menu.click();
  await p.waitForTimeout(500);
  report.menuItems = await p.$$eval("[data-testid^='project-menu-card-'] [role=menuitem]", (els) =>
    els.map((e) => ({ testid: e.getAttribute("data-testid"), text: e.innerText.trim() })),
  );
  await p.screenshot({ path: `${OUT}/${TAG}-row-menu.png`, clip: { x: 0, y: Math.max(0, box.y - 40), width: 640, height: 260 } });
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
}

// Double-click the project label: does the row fold?
const main = group.locator(":scope > .workspace-row .workspace-row-main").first();
const cls = () => row.getAttribute("class");
report.dblclick = { before: await cls() };
await main.dblclick();
await p.waitForTimeout(500);
report.dblclick.after = await cls();
report.dblclick.toggled =
  report.dblclick.before.includes("is-collapsed") !== report.dblclick.after.includes("is-collapsed");
report.dblclick.selection = await p.evaluate(() => {
  const s = window.getSelection();
  return s ? s.toString() : "";
});

// The account menu: is the explainer re-openable?
await p.locator("[data-testid=brand-identity]").click();
await p.waitForTimeout(400);
report.accountMenu = await p.$$eval("[data-testid=profile-menu] [role=menuitem]", (els) =>
  els.map((e) => e.innerText.trim()),
);
await p.screenshot({ path: `${OUT}/${TAG}-account-menu.png`, clip: { x: 0, y: 400, width: 460, height: 550 } });
await p.keyboard.press("Escape");

console.log(JSON.stringify(report, null, 2));
await b.close();
