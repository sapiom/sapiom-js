/**
 * Verifies the typed failure path when the node-pty native addon cannot be
 * loaded: importing the runtime module stays safe (lazy import), and
 * create() rejects with PtyUnavailableError carrying a remediation hint.
 */
jest.mock("node-pty", () => {
  // Simulates a missing/broken native build at require-time.
  throw new Error(
    "The module 'pty.node' was compiled against a different Node.js version",
  );
});

// Importing the runtime must NOT throw even though node-pty is broken —
// node-pty is only imported lazily inside create(). If the lazy import ever
// regresses to a top-level import, this whole file fails at load time.
import { PtyRuntime, PtyUnavailableError, HarnessError } from "../index.js";

describe("PtyRuntime when node-pty is unavailable", () => {
  const createOptions = {
    command: "/bin/echo",
    args: ["hello"],
    env: {},
    cwd: "/",
    cols: 80,
    rows: 24,
  };

  it("can be constructed without touching node-pty", () => {
    expect(() => new PtyRuntime()).not.toThrow();
  });

  it("rejects create() with a typed PtyUnavailableError", async () => {
    const runtime = new PtyRuntime();
    const promise = runtime.create(createOptions);

    await expect(promise).rejects.toBeInstanceOf(PtyUnavailableError);
    await expect(promise).rejects.toBeInstanceOf(HarnessError);
    await expect(promise).rejects.toMatchObject({
      name: "PtyUnavailableError",
      code: "PTY_UNAVAILABLE",
    });
  });

  it("carries a remediation hint and the underlying cause for doctor-style consumers", async () => {
    const runtime = new PtyRuntime();
    const error = await runtime.create(createOptions).then(
      () => {
        throw new Error("expected create() to reject");
      },
      (e: unknown) => e as PtyUnavailableError,
    );

    expect(error.remediation).toContain("pnpm rebuild node-pty");
    expect(error.message).toContain("node-pty");
    expect(error.message).toContain(
      "compiled against a different Node.js version",
    );
    expect(error.cause).toBeInstanceOf(Error);
  });
});
