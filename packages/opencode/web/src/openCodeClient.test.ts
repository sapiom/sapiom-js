import { describe, expect, it } from "vitest";

import { createAssistantUiOpenCodeClient } from "./openCodeClient";

describe("createAssistantUiOpenCodeClient", () => {
  it("suppresses the adapter's duplicate title compaction request", async () => {
    const client = createAssistantUiOpenCodeClient("http://127.0.0.1:1");

    await expect(
      client.session.summarize({ sessionID: "session" }),
    ).resolves.toMatchObject({ data: true });
  });
});
