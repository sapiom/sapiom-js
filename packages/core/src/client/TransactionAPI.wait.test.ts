import { HttpClient } from "./HttpClient";
import { TransactionAPI } from "./TransactionAPI";

it("extends only the bounded transaction request budget and preserves larger client defaults", async () => {
  const http = new HttpClient({
    baseURL: "https://api.example",
    timeout: 30000,
    headers: {},
  });
  const request = jest.spyOn(http, "request").mockResolvedValue({});
  const api = new TransactionAPI(http);
  await api.get("id", { since: "revision", maxWaitSeconds: 45 });
  expect(request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: { since: "revision", maxWaitSeconds: 45 },
      timeoutMs: 50000,
    }),
  );
  await api.get("id");
  expect(request.mock.calls.at(-1)![0]).not.toHaveProperty("timeoutMs");
  await expect(api.get("id", { maxWaitSeconds: Infinity })).rejects.toThrow(
    "maxWaitSeconds",
  );
});
