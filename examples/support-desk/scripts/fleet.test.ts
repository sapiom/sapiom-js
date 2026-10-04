import { describe, expect, it } from "vitest";

import {
  bundleHash,
  connectorsFor,
  missingTriggers,
  parseArgs,
  TRIGGERS,
  triggerBody,
  pausedToResume,
  retiredToDetach,
  RETIRED_TRIGGERS,
  selectProjects,
  triggersFor,
  type AttachedTrigger,
} from "./fleet";

const keys = (ps: { key: string }[]) => ps.map((p) => p.key);
const attached = (
  over: Partial<AttachedTrigger> & Pick<AttachedTrigger, "kind">,
): AttachedTrigger => ({
  id: "1",
  status: "active",
  eventType: null,
  cron: null,
  ...over,
});

describe("setup selection", () => {
  it("deploys every project that is not optional, smoke or manual by default", () => {
    expect(keys(selectProjects(parseArgs([])))).toEqual([
      "intake",
      "copilot",
      "escalation",
      "controller",
      "linear-sync",
      "watchdog",
      "digest",
    ]);
  });

  it("deploys the run-by-hand setup agent only when named, with no triggers", () => {
    expect(keys(selectProjects(parseArgs([])))).not.toContain("setup");
    const only = selectProjects(parseArgs(["--only", "setup"]));
    expect(keys(only)).toEqual(["setup"]);
    expect(triggersFor(only)).toEqual([]);
  });

  it("--only names exactly the projects to act on, optional ones included", () => {
    const only = selectProjects(parseArgs(["--only", "urgent-pager"]));
    expect(keys(only)).toEqual(["urgent-pager"]);
    expect(triggersFor(only)).toEqual([
      { project: "urgent-pager", kind: "event", eventType: "issue.created" },
    ]);
    expect(connectorsFor(only).map((c) => c.provider)).toEqual(["slack"]);
  });

  it("--skip leaves a project out; both flags repeat and take lists", () => {
    expect(
      keys(
        selectProjects(
          parseArgs(["--skip", "controller", "--skip", "copilot"]),
        ),
      ),
    ).toEqual(["intake", "escalation", "linear-sync", "watchdog", "digest"]);
    expect(
      keys(selectProjects(parseArgs(["--only", "intake,urgent-pager"]))),
    ).toEqual(["intake", "urgent-pager"]);
  });

  it("never attaches smoke triggers, even for a smoke project named with --only", () => {
    const smoke = selectProjects(parseArgs(["--only", "smoke-ingest"]));
    expect(keys(smoke)).toEqual(["smoke-ingest"]);
    expect(triggersFor(smoke)).toEqual([]);
  });

  it("rejects an unknown project or flag", () => {
    expect(() => selectProjects(parseArgs(["--only", "nope"]))).toThrow(
      /no project 'nope'/,
    );
    expect(parseArgs(["--only", "controller", "--no-triggers"])).toMatchObject({
      only: ["controller"],
      noTriggers: true,
    });
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--only"])).toThrow(/needs a project key/);
  });
});

describe("trigger dedup", () => {
  const cron = {
    project: "controller",
    kind: "schedule_cron",
    cron: "*/2 * * * *",
  } as const;
  const event = {
    project: "intake",
    kind: "event",
    eventType: "slack.message.created",
  } as const;

  it("treats a matching active or paused trigger as attached", () => {
    expect(
      missingTriggers(
        [cron, event],
        [
          attached({
            kind: "schedule_cron",
            cron: "*/2 * * * *",
            status: "paused",
          }),
          attached({ kind: "event", eventType: "slack.message.created" }),
        ],
      ),
    ).toEqual([]);
  });

  it("re-creates a disabled (deleted) trigger and a cron with another schedule", () => {
    expect(
      missingTriggers(
        [cron, event],
        [
          attached({ kind: "schedule_cron", cron: "*/5 * * * *" }),
          attached({
            kind: "event",
            eventType: "slack.message.created",
            status: "disabled",
          }),
        ],
      ),
    ).toEqual([cron, event]);
  });
});

describe("cron time zone", () => {
  const digest = {
    project: "digest",
    kind: "schedule_cron",
    cron: "0 9 * * *",
    timezone: "America/Los_Angeles",
  } as const;
  const utc = {
    project: "controller",
    kind: "schedule_cron",
    cron: "*/2 * * * *",
  } as const;

  it("fleet.json schedules the digest at 09:00 Pacific", () => {
    expect(TRIGGERS.filter((t) => t.project === "digest")).toEqual([digest]);
  });

  it("sends the zone only when the trigger has one", () => {
    expect(triggerBody(digest)).toEqual({
      kind: "schedule_cron",
      cron: "0 9 * * *",
      timezone: "America/Los_Angeles",
    });
    expect(triggerBody(utc)).toEqual({
      kind: "schedule_cron",
      cron: "*/2 * * * *",
    });
  });

  it("matches a cron only in the same zone, a missing zone meaning UTC", () => {
    const same = attached({
      kind: "schedule_cron",
      cron: "0 9 * * *",
      timezone: "America/Los_Angeles",
    });
    const inUtc = attached({
      kind: "schedule_cron",
      cron: "0 9 * * *",
      timezone: "UTC",
    });
    expect(missingTriggers([digest], [same])).toEqual([]);
    expect(missingTriggers([digest], [inUtc])).toEqual([digest]);
    expect(
      missingTriggers(
        [digest],
        [attached({ kind: "schedule_cron", cron: "0 9 * * *" })],
      ),
    ).toEqual([digest]);
    expect(
      missingTriggers(
        [utc],
        [
          attached({
            kind: "schedule_cron",
            cron: "*/2 * * * *",
            timezone: "UTC",
          }),
        ],
      ),
    ).toEqual([]);
    expect(
      missingTriggers(
        [utc],
        [
          attached({
            kind: "schedule_cron",
            cron: "*/2 * * * *",
            timezone: null,
          }),
        ],
      ),
    ).toEqual([]);
  });
});

describe("paused triggers", () => {
  const event = {
    project: "intake",
    kind: "event",
    eventType: "slack.message.created",
  } as const;
  const paused = attached({
    id: "7",
    kind: "event",
    eventType: "slack.message.created",
    status: "paused",
  });

  it("resumes a paused trigger that matches fleet.json", () => {
    expect(pausedToResume([event], [paused])).toEqual([
      { want: event, trigger: paused },
    ]);
  });

  it("leaves it alone when an active duplicate already serves the trigger", () => {
    const active = attached({
      kind: "event",
      eventType: "slack.message.created",
    });
    expect(pausedToResume([event], [paused, active])).toEqual([]);
    expect(pausedToResume([event], [active])).toEqual([]);
  });
});

describe("bundleHash", () => {
  it("changes with the code or a dependency version, not with key order", () => {
    const a = bundleHash({
      code: "x",
      dependencies: { zod: "4.1.12", postgres: "3.4.9" },
    });
    expect(
      bundleHash({
        code: "x",
        dependencies: { postgres: "3.4.9", zod: "4.1.12" },
      }),
    ).toBe(a);
    expect(
      bundleHash({
        code: "y",
        dependencies: { zod: "4.1.12", postgres: "3.4.9" },
      }),
    ).not.toBe(a);
    expect(
      bundleHash({
        code: "x",
        dependencies: { zod: "4.1.13", postgres: "3.4.9" },
      }),
    ).not.toBe(a);
  });
});

describe("retired triggers", () => {
  it("detaches the watchdog's old poll, active or paused, and nothing else", () => {
    const poll = { kind: "schedule_cron", cron: "*/5 * * * *" } as const;
    const have = [
      attached({ id: "7", ...poll }),
      attached({ id: "8", ...poll, status: "paused" }),
      attached({ id: "9", ...poll, status: "disabled" }),
      attached({ id: "10", kind: "event", eventType: "sapiom.run.failed" }),
    ];
    expect(retiredToDetach("watchdog", have).map((t) => t.id)).toEqual([
      "7",
      "8",
    ]);
    expect(retiredToDetach("controller", have)).toEqual([]);
  });

  it("are never also wanted", () => {
    for (const r of RETIRED_TRIGGERS)
      expect(missingTriggers(TRIGGERS, [])).not.toContainEqual(r);
  });
});
