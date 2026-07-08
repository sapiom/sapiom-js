import { describe, it, expect, vi } from "vitest";
import { PortDetector } from "./port-detector.js";

function makeDetector() {
  const onPort = vi.fn();
  const detector = new PortDetector({ onPort });
  return { detector, onPort };
}

describe("PortDetector.feed", () => {
  it("finds a localhost:<port> reference in a single chunk", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("Server running at http://localhost:3000\n", "sess-1");
    expect(onPort).toHaveBeenCalledWith("sess-1", 3000, "http://localhost:3000");
  });

  it("finds a bare localhost:<port> without a scheme", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("$ npm run dev\n> Local:   localhost:5173/\n", "sess-1");
    expect(onPort).toHaveBeenCalledWith("sess-1", 5173, "http://localhost:5173");
  });

  it("does not fire when there's no localhost reference", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("Compiled successfully.\n", "sess-1");
    expect(onPort).not.toHaveBeenCalled();
  });

  it("detects a port split across two chunks", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("ready - started server on http://local", "sess-1");
    expect(onPort).not.toHaveBeenCalled(); // nothing to finalize yet
    detector.feed("host:3001\n", "sess-1");
    expect(onPort).toHaveBeenCalledWith("sess-1", 3001, "http://localhost:3001");
  });

  it("does not prematurely finalize a port mid-digit-stream, even split oddly", () => {
    const { detector, onPort } = makeDetector();
    // "3" then "000" — if the detector finalized eagerly on every chunk
    // boundary it could report port 3 here.
    detector.feed("http://localhost:3", "sess-1");
    expect(onPort).not.toHaveBeenCalled();
    detector.feed("000 is up\n", "sess-1");
    expect(onPort).toHaveBeenCalledTimes(1);
    expect(onPort).toHaveBeenCalledWith("sess-1", 3000, "http://localhost:3000");
  });

  it("dedupes repeated appearances of the same (session, port)", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("localhost:4000 localhost:4000\n", "sess-1");
    detector.feed("still on localhost:4000\n", "sess-1");
    expect(onPort).toHaveBeenCalledTimes(1);
  });

  it("tracks ports independently per session", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("localhost:4000\n", "sess-1");
    detector.feed("localhost:4000\n", "sess-2");
    expect(onPort).toHaveBeenCalledTimes(2);
    expect(onPort).toHaveBeenNthCalledWith(1, "sess-1", 4000, "http://localhost:4000");
    expect(onPort).toHaveBeenNthCalledWith(2, "sess-2", 4000, "http://localhost:4000");
  });

  it("fires again for a genuinely different port on the same session", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("localhost:4000\n", "sess-1");
    detector.feed("localhost:5000\n", "sess-1");
    expect(onPort).toHaveBeenCalledTimes(2);
  });

  it("ignores an out-of-range port number", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("localhost:99999\n", "sess-1");
    expect(onPort).not.toHaveBeenCalled();
  });

  it("reset() clears dedupe state so the same port fires again", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("localhost:4000\n", "sess-1");
    expect(onPort).toHaveBeenCalledTimes(1);
    detector.reset("sess-1");
    detector.feed("localhost:4000\n", "sess-1");
    expect(onPort).toHaveBeenCalledTimes(2);
  });

  it("does not leak unbounded buffer growth from a flood of unrelated text", () => {
    const { detector, onPort } = makeDetector();
    for (let i = 0; i < 1000; i++) {
      detector.feed("no ports here, just noise ".repeat(10), "sess-1");
    }
    detector.feed("localhost:6000\n", "sess-1");
    expect(onPort).toHaveBeenCalledWith("sess-1", 6000, "http://localhost:6000");
  });

  it("holds back a port that lands exactly at the end of a fed chunk, without flush()", () => {
    // A discrete tool.call payload's text commonly ends *exactly* on the
    // port digits, with no trailing character — this must not misfire as a
    // truncated port, but it also must not just vanish: see flush() below.
    const { detector, onPort } = makeDetector();
    detector.feed("ready - started server on http://localhost:5544", "sess-1");
    expect(onPort).not.toHaveBeenCalled();
  });
});

describe("PortDetector.flush", () => {
  it("finalizes a port held back at the end of a discrete, complete string", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("ready - started server on http://localhost:5544", "sess-1");
    expect(onPort).not.toHaveBeenCalled();

    detector.flush("sess-1");
    expect(onPort).toHaveBeenCalledWith("sess-1", 5544, "http://localhost:5544");
  });

  it("is a harmless no-op when there's nothing pending", () => {
    const { detector, onPort } = makeDetector();
    detector.flush("sess-1");
    expect(onPort).not.toHaveBeenCalled();
  });

  it("does not re-emit an already-finalized port", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("localhost:4000\n", "sess-1");
    detector.flush("sess-1");
    expect(onPort).toHaveBeenCalledTimes(1);
  });

  it("still respects per-(session,port) dedupe across feed+flush calls", () => {
    const { detector, onPort } = makeDetector();
    detector.feed("http://localhost:5544", "sess-1");
    detector.flush("sess-1");
    detector.feed("http://localhost:5544", "sess-1");
    detector.flush("sess-1");
    expect(onPort).toHaveBeenCalledTimes(1);
  });
});
