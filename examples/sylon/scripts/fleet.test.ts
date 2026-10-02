import { describe, expect, it } from "vitest";

import {
  bundleHash,
  connectorsFor,
  missingTriggers,
  parseArgs,
  pausedToResume,
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
  it("deploys every project that is neither optional nor smoke by default", () => {
    expect(keys(selectProjects(parseArgs([])))).toEqual([
      "intake",
      "copilot",
      "escalation",
      "controller",
    ]);
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
    ).toEqual(["intake", "escalation"]);
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
