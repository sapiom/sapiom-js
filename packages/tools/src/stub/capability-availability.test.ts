/**
 * Regression coverage for issue #155: run_local must expose memory / database /
 * email / domains on the stub client, and any missing top-level capability must
 * throw a legible CapabilityNotAvailableError instead of an opaque TypeError.
 */
import {
  CapabilityNotAvailableError,
  createStubClient,
} from "./index.js";

describe("createStubClient — issue #155 capability availability", () => {
  it("stubs memory, database, email, and domains (not undefined)", async () => {
    const client = createStubClient();

    expect(client.memory).toBeDefined();
    expect(client.database).toBeDefined();
    expect(client.email).toBeDefined();
    expect(client.domains).toBeDefined();

    const appended = await client.memory.append({
      content: "hello",
      namespace: "demo",
    });
    expect(appended).toMatchObject({ content: "hello" });

    const db = await client.database.create({ duration: "1h" });
    expect(db).toMatchObject({ id: expect.any(String) });

    const inbox = await client.email.inboxes.create();
    expect(inbox).toMatchObject({ email: expect.any(String) });

    const availability = await client.domains.check({
      domainNames: ["example.com"],
    });
    expect(Array.isArray(availability)).toBe(true);
  });

  it("throws CapabilityNotAvailableError for a missing top-level capability", () => {
    const client = createStubClient() as unknown as Record<string, unknown>;

    expect(() => client.notARealCapability).toThrow(CapabilityNotAvailableError);
    try {
      void client.notARealCapability;
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityNotAvailableError);
      expect((err as CapabilityNotAvailableError).capability).toBe(
        "notARealCapability",
      );
      expect((err as Error).message).toMatch(/not available under run_local/i);
    }
  });
});
