/**
 * Regression tests for the stub's Google/GitHub capability overrides — the two
 * behaviours a review (Devin + CodeRabbit) flagged, and this change fixes:
 *
 *  B — an override for `connectors.google.authClient` MUST be returned. Previously the stub
 *      invoked the resolver for its side effect, discarded the result, and always
 *      imported `google-auth-library` and returned the real client — so an override
 *      could neither control the result nor avoid the optional peer.
 *  D — a Promise-returning stub whose override THROWS must REJECT, not throw
 *      synchronously. Previously `() => Promise.resolve(r(...))` evaluated the
 *      throwing override before `Promise.resolve`, so it escaped the call site and
 *      code that stored the promise to await/catch later never saw a rejection.
 */
import { createStubClient } from "./index.js";

describe("stub google/github overrides", () => {
  it("returns a value override for google.authClient (does not discard it)", async () => {
    const fake = { getRequestHeaders: async () => new Headers() };
    const client = createStubClient({
      overrides: { "connectors.google.authClient": fake },
    });

    expect(await client.connectors.google.authClient()).toBe(fake);
  });

  it("calls and returns a function override for google.authClient", async () => {
    const fake = { getRequestHeaders: async () => new Headers() };
    const client = createStubClient({
      overrides: { "connectors.google.authClient": () => fake },
    });

    expect(await client.connectors.google.authClient()).toBe(fake);
  });

  it("rejects when a google.drive.shareFile override throws", async () => {
    const client = createStubClient({
      overrides: {
        "connectors.google.drive.shareFile": () => {
          throw new Error("drive boom");
        },
      },
    });

    const pending = client.connectors.google.drive.shareFile({
      fileId: "f",
      role: "reader",
      type: "anyone",
    });
    await expect(pending).rejects.toThrow("drive boom");
  });

  it("rejects when a github.listRepos override throws", async () => {
    const client = createStubClient({
      overrides: {
        "connectors.github.listRepos": () => {
          throw new Error("gh boom");
        },
      },
    });

    const pending = client.connectors.github.listRepos();
    await expect(pending).rejects.toThrow("gh boom");
  });
});
