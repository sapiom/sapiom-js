/**
 * Public-surface smoke test for @sapiom/tools.
 *
 * Asserts the package's exported surface is wired and importable — `createClient`
 * builds a `Sapiom` with the expected capability namespaces, `withAttribution`
 * derives a same-shaped client, and the barrel re-exports the namespaces +
 * resource classes. It makes NO network calls: `createClient` only binds a
 * transport (the missing-credential error fires on a request, not at
 * construction), so constructing + shape-checking is side-effect-free.
 */
import {
  createClient,
  sandboxes,
  repositories,
  agent,
  search,
  Sandbox,
  Repository,
  SearchHttpError,
} from "./index.js";

describe("@sapiom/tools public surface", () => {
  it("exposes createClient as a function", () => {
    expect(typeof createClient).toBe("function");
  });

  it("createClient builds a Sapiom with the expected capability namespaces", () => {
    const sapiom = createClient({ apiKey: "test-key" });

    expect(typeof sapiom.sandboxes.create).toBe("function");
    expect(typeof sapiom.sandboxes.attach).toBe("function");

    expect(typeof sapiom.repositories.create).toBe("function");
    expect(typeof sapiom.repositories.get).toBe("function");
    expect(typeof sapiom.repositories.list).toBe("function");
    expect(typeof sapiom.repositories.delete).toBe("function");
    expect(typeof sapiom.repositories.attach).toBe("function");

    expect(typeof sapiom.agent.coding.run).toBe("function");
    expect(typeof sapiom.agent.coding.launch).toBe("function");

    expect(typeof sapiom.search).toBe("object");

    expect(typeof sapiom.withAttribution).toBe("function");
  });

  it("withAttribution derives a client of the same shape", () => {
    const derived = createClient({ apiKey: "test-key" }).withAttribution({});
    expect(typeof derived.sandboxes.create).toBe("function");
    expect(typeof derived.agent.coding.run).toBe("function");
    expect(typeof derived.withAttribution).toBe("function");
  });

  it("barrel re-exports the capability namespaces and resource classes", () => {
    expect(typeof sandboxes).toBe("object");
    expect(typeof repositories).toBe("object");
    expect(typeof agent).toBe("object");
    expect(typeof search).toBe("object");
    expect(typeof SearchHttpError).toBe("function"); // error class constructor
    expect(typeof Sandbox).toBe("function"); // class constructor
    expect(typeof Repository).toBe("function");
  });

  it("the search namespace has no self-named nested key", () => {
    // The barrel creates the `search` namespace via `export * as search`; the
    // module itself must not export a const named after itself, or methods would
    // read as `search.search.webSearch()`.
    expect("search" in search).toBe(false);
  });
});
