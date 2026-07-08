import { describe, it, expect } from "vitest";
import { detectPort, detectPortInPayload } from "./port-detector.js";

describe("detectPort", () => {
  it("finds a localhost:<port> reference", () => {
    expect(detectPort("Server running at http://localhost:3000")).toEqual({
      port: 3000,
      url: "http://localhost:3000",
    });
  });

  it("finds a port embedded in a longer log line", () => {
    expect(detectPort("$ npm run dev\n> Local:   http://localhost:5173/\n")).toEqual({
      port: 5173,
      url: "http://localhost:5173",
    });
  });

  it("returns null when there's no localhost reference", () => {
    expect(detectPort("Compiled successfully.")).toBeNull();
  });

  it("returns null for a malformed port (too many digits)", () => {
    expect(detectPort("localhost:123456")).toBeNull();
  });

  it("returns null for a single-digit port (below the 2-5 digit window)", () => {
    expect(detectPort("localhost:8")).toBeNull();
  });
});

describe("detectPortInPayload", () => {
  it("finds a port in the command field", () => {
    expect(detectPortInPayload({ command: "vite --port 4321 & open http://localhost:4321" })).toEqual({
      port: 4321,
      url: "http://localhost:4321",
    });
  });

  it("finds a port in the output field when command has none", () => {
    expect(
      detectPortInPayload({
        command: "npm run dev",
        output: "ready - started server on http://localhost:3001",
      }),
    ).toEqual({ port: 3001, url: "http://localhost:3001" });
  });

  it("returns null when no candidate field has a port", () => {
    expect(detectPortInPayload({ command: "ls -la", output: "total 0" })).toBeNull();
  });

  it("ignores non-string candidate fields", () => {
    expect(detectPortInPayload({ command: 12345, output: null })).toBeNull();
  });

  it("returns null for an empty payload", () => {
    expect(detectPortInPayload({})).toBeNull();
  });
});
