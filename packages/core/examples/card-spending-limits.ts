import { SapiomClient } from "@sapiom/core";

/** Run from a trusted platform backend after the matching API and SDK have been released. */
async function configureCard() {
  const apiKey = process.env.SAPIOM_MANAGEMENT_API_KEY;
  const cardId = process.env.SAPIOM_CARD_ID;
  if (!apiKey || !cardId)
    throw new Error("Set SAPIOM_MANAGEMENT_API_KEY and SAPIOM_CARD_ID");
  const client = new SapiomClient({
    apiKey,
    baseURL: process.env.SAPIOM_API_URL,
    backgroundRefresh: false,
  });
  const current = await client.paymentCards.getSpendingLimits(cardId);
  const saved = await client.paymentCards.setSpendingLimits(cardId, {
    version: current.version,
    purchaseLimit: { amount: "100.00", currency: "USD" },
    recurringLimit: { amount: "500.00", currency: "USD", period: "month" },
    customLimit: null,
  });
  console.log(
    JSON.stringify(
      { cardId, version: saved.version, usage: saved.usage },
      null,
      2,
    ),
  );
}
void configureCard().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
