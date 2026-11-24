import { TransactionPoller } from "./TransactionPoller.js";
import { SapiomClient } from "./SapiomClient.js";

describe("purchase polling", () => {
  it.each(["needs_revision", "authorized"])(
    "returns a revision immediately with status %s",
    async (status) => {
      const transaction = {
        id: "tx",
        status,
        nextAction: {
          type: "revise",
          actor: "agent",
          reasons: [
            { ruleId: "r", code: "rule_denied", message: "Over the limit" },
          ],
        },
      };
      const get = jest.fn().mockResolvedValue(transaction);
      const poller = new TransactionPoller(
        { transactions: { get } } as unknown as SapiomClient,
        {},
      );
      expect(await poller.waitForAuthorization("tx")).toEqual({
        status: "needs_revision",
        transaction,
      });
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it("waits through an approval and returns authorization when it arrives", async () => {
    const authorized = { id: "tx", status: "authorized" };
    const get = jest
      .fn()
      .mockResolvedValueOnce({ id: "tx", status: "waiting_approval" })
      .mockResolvedValue(authorized);
    const poller = new TransactionPoller(
      { transactions: { get } } as unknown as SapiomClient,
      { pollInterval: 1 },
    );
    expect(await poller.waitForAuthorization("tx")).toEqual({
      status: "authorized",
      transaction: authorized,
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
