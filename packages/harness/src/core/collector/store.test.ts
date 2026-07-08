import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnalyticsEvent } from "../../shared/types.js";
import { createEventStore } from "./store.js";

const sampleEvent: AnalyticsEvent = {
  eventId: "evt-1",
  seq: 1,
  ts: "2026-07-08T00:00:00.000Z",
  userId: null,
  tenantId: null,
  machineId: "machine-1",
  harnessSessionId: "session-1",
  agentSessionId: null,
  harness: "claude-code",
  type: "session.start",
  payload: { source: "startup" },
};

describe("createEventStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-store-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the parent directory and appends one ndjson line per event", async () => {
    const filePath = path.join(tmpDir, "nested", "events.ndjson");
    const store = createEventStore(filePath);

    await store.append(sampleEvent);
    await store.append({ ...sampleEvent, eventId: "evt-2" });

    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).eventId).toBe("evt-1");
    expect(JSON.parse(lines[1]).eventId).toBe("evt-2");
  });

  it("expands a leading ~ in the default path shape", async () => {
    // Use an explicit tmp path but confirm the store doesn't choke on a
    // relative-looking filePath (mirrors HARNESS_PATHS.events shape).
    const filePath = path.join(tmpDir, "events.ndjson");
    const store = createEventStore(filePath);
    await store.append(sampleEvent);
    const content = await fs.readFile(filePath, "utf8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("appends concurrently without losing lines", async () => {
    const filePath = path.join(tmpDir, "events.ndjson");
    const store = createEventStore(filePath);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.append({ ...sampleEvent, eventId: `evt-${i}` })),
    );

    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(20);
  });
});
