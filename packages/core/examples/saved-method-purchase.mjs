// Run with Node 20+: SAPIOM_API_KEY=... PURCHASE_REQUEST=./request.json node saved-method-purchase.mjs
// request.json: { "idempotencyKey": "retain-this-key", "request": { "purchase":
// { "type": "ucp_checkout", "merchant": { "origin": "https://shop.example" },
// "checkout": { "line_items": [{ "item": { "id": "item-1" }, "quantity": 1 }] } },
// "funding": { "paymentMethodId": "saved-method-uuid" } } }
import { readFile } from "node:fs/promises";
import { SapiomClient, SapiomApiError } from "@sapiom/core";

const client = new SapiomClient({
  apiKey: process.env.SAPIOM_API_KEY,
  baseURL: process.env.SAPIOM_API_URL,
});
const command = process.argv[2] ?? "list";
const id = process.env.TRANSACTION_ID;
const safeStatus = (tx) =>
  console.log(
    JSON.stringify({
      id: tx.id,
      version: tx.version,
      paymentMethodId: tx.paymentMethodId,
      paymentMethodKind: tx.paymentMethodKind,
      nextAction: { type: tx.nextAction?.type, actor: tx.nextAction?.actor },
      order: tx.order,
    }),
  );
try {
  if (command === "list") {
    const methods = await client.paymentMethods.list();
    console.log(
      methods.data.map(({ id, kind, readiness }) => ({ id, kind, readiness })),
    );
  } else if (command === "limits") {
    // Management is a separate grant. Never give this credential to the purchasing agent.
    const management = new SapiomClient({
      apiKey: process.env.SAPIOM_MANAGEMENT_KEY,
      baseURL: process.env.SAPIOM_API_URL,
    });
    console.log(
      await management.paymentMethods.getSpendingLimits(
        process.env.PAYMENT_METHOD_ID,
      ),
    );
  } else if (command === "create") {
    const { request, idempotencyKey } = JSON.parse(
      await readFile(process.env.PURCHASE_REQUEST, "utf8"),
    );
    const compatibility = await client.transactions.checkCompatibility(
      request.purchase.merchant.origin,
    );
    if (
      request.purchase.type === "ucp_checkout" &&
      compatibility.status !== "supported"
    )
      throw new Error(
        "Structured checkout unavailable. Browser checkout requires a ready card and its own purchase statement.",
      );
    safeStatus(await client.transactions.create(request, { idempotencyKey }));
  } else {
    if (!id) throw new Error("Set TRANSACTION_ID from the previous response.");
    if (command === "cancel")
      safeStatus(
        await client.transactions.cancel(id, {
          idempotencyKey: process.env.OPERATION_KEY,
        }),
      );
    else if (command === "revise") {
      const body = JSON.parse(
        await readFile(process.env.CHECKOUT_REQUEST, "utf8"),
      );
      await client.transactions.updateCheckout(id, body, {
        idempotencyKey: process.env.OPERATION_KEY,
      });
      safeStatus(await client.transactions.get(id));
    } else if (command === "reconcile") {
      await client.transactions.refreshCheckout(id); // Reconcile uncertain merchant state; never resubmit payment.
      safeStatus(await client.transactions.get(id));
    } else if (command === "poll") {
      safeStatus(
        await client.transactions.get(id, {
          since: process.env.PURCHASE_VERSION,
          maxWaitSeconds: 25,
        }),
      );
    } else
      throw new Error(
        "Use list, limits, create, poll, revise, reconcile or cancel.",
      );
  }
  // Follow nextAction.actor: buyer/approver actions belong to that person. Do not log their secret URLs.
  // Browser Pay handles a card payment_ready action. payment_submitted is not merchant order confirmation.
  // An unknown order stays unknown; stop rather than buying again.
} catch (error) {
  if (error instanceof SapiomApiError)
    console.error({
      status: error.status,
      code: error.code,
      requestId: error.requestId,
    });
  else console.error(error.message);
  process.exitCode = 1; // Resume creates with the same saved body/key; reconcile uncertain updates explicitly.
}
