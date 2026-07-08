/**
 * Contract-fixture validation. Every fixture under `fixtures/contract/` is:
 *
 * 1. schema-checked (descriptor shape, filename/name agreement, sane status)
 * 2. validated against the envelope builder — events may OMIT fields
 *    (leniency), but any field they carry must match what `buildEnvelope`
 *    produces, and the happy-path fixture must carry the builder's exact
 *    field set
 * 3. replayed against the mock collector from
 *    `@sapiom/analytics-core/testing`, which must answer with the fixture's
 *    expected status (and response body, where one is pinned)
 *
 * The fixtures are consumed downstream (collector end-to-end tests, per-
 * package instrumentation tests), so this suite is what keeps them honest.
 */
import * as fs from "fs";
import * as path from "path";

import { buildEnvelope, SCHEMA_VERSION } from "../envelope.js";
import { startMockCollector, type MockCollector } from "../testing/index.js";
import type { Envelope } from "../types.js";
import { UUID_V4_REGEX } from "./helpers.js";

const FIXTURES_DIR = path.join(__dirname, "..", "..", "fixtures", "contract");

interface ContractFixture {
  name: string;
  rule: string;
  description: string;
  request: {
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  expected: {
    status: number;
    response?: Record<string, unknown>;
    notes?: string;
  };
}

interface LoadedFixture {
  kind: "valid" | "invalid";
  file: string;
  fixture: ContractFixture;
}

function loadDir(kind: "valid" | "invalid"): LoadedFixture[] {
  const dir = path.join(FIXTURES_DIR, kind);
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      kind,
      file,
      fixture: JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf8"),
      ) as ContractFixture,
    }));
}

const validFixtures = loadDir("valid");
const invalidFixtures = loadDir("invalid");
const allFixtures = [...validFixtures, ...invalidFixtures];

/** Envelope fields the emitter produces, with their wire types. */
const ENVELOPE_FIELD_TYPES: Record<string, "string"> = {
  event_id: "string",
  anonymous_id: "string", // may also be null on the wire
  session_id: "string",
  event_timestamp: "string",
  source: "string",
  event_type: "string",
  user_id: "string",
  sdk_name: "string",
  sdk_version: "string",
  schema_version: "string",
  environment: "string",
  // `data` is deliberately absent: leniency allows any JSON value.
};

const UUID_FIELDS = ["event_id", "anonymous_id", "session_id"] as const;

function eventsOf(fixture: ContractFixture): Record<string, unknown>[] {
  const body = fixture.request.body as { events?: unknown } | undefined;
  if (!body || !Array.isArray(body.events)) return [];
  return body.events.filter(
    (event): event is Record<string, unknown> =>
      event !== null && typeof event === "object" && !Array.isArray(event),
  );
}

describe("contract fixtures", () => {
  it("both fixture directories exist and are non-empty", () => {
    expect(validFixtures.length).toBeGreaterThan(0);
    expect(invalidFixtures.length).toBeGreaterThan(0);
  });

  it("covers every leniency-table rule and every documented rejection", () => {
    const names = validFixtures.map(({ fixture }) => fixture.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "missing-event-id",
        "missing-timestamps",
        "missing-identity-fields",
        "unknown-top-level-keys",
        "unknown-source-and-event-type",
        "data-not-an-object",
        "invalid-api-key-ignored",
        "minimal-empty-event",
        "no-events-key",
        "happy-path-single-event",
        "happy-path-batch",
      ]),
    );
    expect(invalidFixtures.map(({ fixture }) => fixture.name)).toEqual(
      expect.arrayContaining(["not-json", "empty-body", "too-many-events"]),
    );
  });

  describe.each(
    allFixtures.map(
      (loaded) => [`${loaded.kind}/${loaded.file}`, loaded] as const,
    ),
  )("%s", (_label, loaded) => {
    const { kind, file, fixture } = loaded;

      it("matches the descriptor schema", () => {
        expect(fixture.name).toBe(file.replace(/\.json$/, ""));
        expect(typeof fixture.rule).toBe("string");
        expect(fixture.rule.length).toBeGreaterThan(0);
        expect(typeof fixture.description).toBe("string");
        expect(fixture.description.length).toBeGreaterThan(0);

        // Exactly one payload form: a JSON `body` or a literal `rawBody`.
        const hasBody = "body" in fixture.request;
        const hasRawBody = "rawBody" in fixture.request;
        expect(hasBody !== hasRawBody).toBe(true);

        if (kind === "valid") {
          expect(fixture.expected.status).toBe(202);
        } else {
          expect([400, 413, 429]).toContain(fixture.expected.status);
        }
      });

      it("carries a JSON-serializable, stable payload", () => {
        if ("rawBody" in fixture.request) {
          expect(typeof fixture.request.rawBody).toBe("string");
          return;
        }
        const roundTripped: unknown = JSON.parse(
          JSON.stringify(fixture.request.body),
        );
        expect(roundTripped).toEqual(fixture.request.body);
      });

      it("only uses envelope fields the way the emitter produces them", () => {
        for (const event of eventsOf(fixture)) {
          for (const [field, expectedType] of Object.entries(
            ENVELOPE_FIELD_TYPES,
          )) {
            if (!(field in event)) continue; // omission is the leniency point
            const value = event[field];
            if (field === "anonymous_id" && value === null) continue;
            expect(typeof value).toBe(expectedType);
          }
          for (const field of UUID_FIELDS) {
            const value = event[field];
            if (typeof value === "string") {
              expect(value).toMatch(UUID_V4_REGEX);
            }
          }
          if (typeof event.event_timestamp === "string") {
            expect(
              new Date(event.event_timestamp).toString(),
            ).not.toBe("Invalid Date");
          }
          if (typeof event.schema_version === "string") {
            expect(event.schema_version).toBe(SCHEMA_VERSION);
          }
        }
      });
  });

  it("happy-path-single-event carries exactly the envelope builder's field set", () => {
    const happyPath = validFixtures.find(
      ({ fixture }) => fixture.name === "happy-path-single-event",
    );
    expect(happyPath).toBeDefined();
    const [event] = eventsOf(happyPath!.fixture);

    const reference: Envelope = buildEnvelope({
      config: {
        source: "ui",
        sdkName: "@sapiom/harness",
        sdkVersion: "0.1.0",
        userId: "usr_123",
      },
      anonymousId: "b7e2a3f1-4c5d-4a6b-8e9f-0a1b2c3d4e5f",
      sessionId: "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9",
      eventType: "prompt_submitted",
      data: { prompt: "..." },
      overrides: { environment: "development" },
    });

    expect(Object.keys(event).sort()).toEqual(
      Object.keys(reference).sort(),
    );
    expect(event.schema_version).toBe(reference.schema_version);
    expect(event.source).toBe(reference.source);
    expect(event.sdk_name).toBe(reference.sdk_name);
  });

  it("every batch event's fields are a subset of the builder's envelope", () => {
    const reference = buildEnvelope({
      config: {
        source: "cli",
        sdkName: "@sapiom/cli",
        sdkVersion: "0.0.0",
        userId: "usr_reference",
      },
      anonymousId: "b7e2a3f1-4c5d-4a6b-8e9f-0a1b2c3d4e5f",
      sessionId: "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9",
      eventType: "reference",
      overrides: { environment: "test" },
    });
    const builderFields = new Set(Object.keys(reference));

    for (const { fixture } of validFixtures) {
      // This fixture intentionally carries keys outside the envelope — and
      // they must STAY outside it, or the exclusion would hide a regression.
      if (fixture.name === "unknown-top-level-keys") {
        for (const extra of ["org_id", "api_key_id", "favorite_color"]) {
          expect(builderFields).not.toContain(extra);
        }
        continue;
      }
      for (const event of eventsOf(fixture)) {
        for (const field of Object.keys(event)) {
          expect(builderFields).toContain(field);
        }
      }
    }
  });

  it("invalid fixtures are invalid for the reason they claim", () => {
    for (const { fixture } of invalidFixtures) {
      if (fixture.request.rawBody !== undefined) {
        expect(() => JSON.parse(fixture.request.rawBody as string)).toThrow();
      } else {
        // Batch-limit rejection: more events than the contract's 500 cap.
        expect(eventsOf(fixture).length).toBeGreaterThan(500);
      }
    }
  });

  describe("replayed against the mock collector", () => {
    let collector: MockCollector;

    beforeAll(async () => {
      collector = await startMockCollector();
    });

    afterAll(async () => {
      await collector.close();
    });

    it.each(
      allFixtures.map(
        (loaded) => [`${loaded.kind}/${loaded.file}`, loaded] as const,
      ),
    )("%s gets its expected response", async (_label, loaded) => {
      const { fixture } = loaded;
      const body =
        fixture.request.rawBody !== undefined
          ? fixture.request.rawBody
          : JSON.stringify(fixture.request.body);

      const response = await fetch(collector.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...fixture.request.headers,
        },
        body,
      });
      expect(response.status).toBe(fixture.expected.status);

      if (fixture.expected.response) {
        expect(await response.json()).toEqual(fixture.expected.response);
      }
    });
  });
});
