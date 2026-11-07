/**
 * Type the purchase's placeholder into the checkout's card form, then decide yourself
 * whether to press Pay. Attach the interceptor first (see attach.ts) on the same CDP URL.
 *
 *   CDP_URL=… PLACEHOLDER_NUMBER=… PLACEHOLDER_EXP_MONTH=… PLACEHOLDER_EXP_YEAR=… \
 *   PLACEHOLDER_CVC=… npx tsx examples/fill-card.ts
 */
import { chromium } from "playwright";
import { fillCard, type PageLike } from "../src/index.js";

async function main(): Promise<void> {
  const cdpUrl = process.env.CDP_URL;
  if (!cdpUrl) throw new Error("CDP_URL is required");
  const browser = await chromium.connectOverCDP(cdpUrl);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error("no open page on that browser");

  const result = await fillCard(page as unknown as PageLike, {
    number: process.env.PLACEHOLDER_NUMBER ?? "",
    expMonth: Number(process.env.PLACEHOLDER_EXP_MONTH),
    expYear: Number(process.env.PLACEHOLDER_EXP_YEAR),
    cvc: process.env.PLACEHOLDER_CVC ?? "",
  });
  // Only field kinds and frame origins: safe to log.
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    // Nothing was sent. Cancel the purchase or retry the fill; never press Pay half-filled.
    process.exitCode = 1;
  }
  await browser.close();
}

void main();
