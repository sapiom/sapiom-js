import { expect, it, vi } from "vitest";
import type { AssistantLifecycle } from "../shared/assistant-session.js";
import {
  parseAssistantState,
  type AssistantStateSnapshot,
} from "../shared/assistant-state.js";
import { createAssistantStateProjection } from "./assistant-state-projection.js";

const state: AssistantLifecycle = {
  version: 1,
  harnessSessionId: "studio-a",
  revision: 2,
  lifecycle: "ended",
  execution: "paused",
  updatedAt: 10,
};
const runtime: AssistantStateSnapshot = {
  hostInstanceId: "host-a",
  authorityRevision: "grant-a",
  revision: 45,
  enabled: true,
  sessions: [],
};
it("orders lifecycle-only updates with observations and clears disabled projections", () => {
  let changedHost!: () => void, changedLifecycle!: () => void;
  let native = runtime;
  let rows = [state];
  const stopHost = vi.fn(),
    stopLifecycle = vi.fn(),
    publish = vi.fn();
  const projection = createAssistantStateProjection(
    {
      getAssistantState: () => native,
      subscribeAssistantState: (fn) => {
        changedHost = fn;
        return stopHost;
      },
    },
    {
      snapshot: () => rows,
      subscribe: (fn) => {
        changedLifecycle = fn;
        return stopLifecycle;
      },
    },
    publish,
  );
  const initial = projection.get();
  expect(parseAssistantState(initial)).toEqual(initial);
  rows = [{ ...state, revision: 0, lifecycle: "open" }];
  expect(projection.get().lifecycles).toEqual([]);
  rows = [{ ...state, revision: 0, lifecycle: "ending" }];
  expect(projection.get().lifecycles?.[0]?.lifecycle).toBe("ending");
  rows = [{ ...state, revision: 3, lifecycle: "open" }];
  changedLifecycle();
  const resumed = publish.mock.lastCall![0] as AssistantStateSnapshot;
  expect(resumed.revision).toBeGreaterThan(initial.revision);
  expect(resumed.lifecycles?.[0]?.lifecycle).toBe("open");
  native = {
    ...native,
    enabled: false,
    authorityRevision: "grant-b",
    revision: 46,
  };
  changedHost();
  const revoked = publish.mock.lastCall![0] as AssistantStateSnapshot;
  expect(revoked.revision).toBeGreaterThan(resumed.revision);
  expect(revoked.lifecycles).toEqual([]);
  expect(parseAssistantState(revoked)).toEqual(revoked);
  projection.dispose();
  expect(stopHost).toHaveBeenCalledOnce();
  expect(stopLifecycle).toHaveBeenCalledOnce();
});
it("keeps private continuation runtimes and lifecycle headers out of every snapshot", () => {
  let visible = false;
  let changed!: () => void;
  const publish = vi.fn();
  const projection = createAssistantStateProjection(
    {
      getAssistantState: () => ({
        ...runtime,
        sessions: [
          {
            harnessSessionId: state.harnessSessionId,
            conversationId: "ses_private",
            activity: "idle",
            pendingPermissions: 0,
            pendingQuestions: 0,
            freshness: "current",
          },
        ],
      }),
      subscribeAssistantState: () => () => {},
    },
    {
      snapshot: () => [state],
      subscribe: (fn) => {
        changed = fn;
        return () => {};
      },
    },
    publish,
    () => visible,
  );
  expect(projection.get()).toMatchObject({ sessions: [], lifecycles: [] });
  changed();
  expect(publish.mock.lastCall?.[0]).toMatchObject({
    sessions: [],
    lifecycles: [],
  });
  visible = true;
  changed();
  expect(publish.mock.lastCall?.[0]).toMatchObject({
    sessions: [{ harnessSessionId: state.harnessSessionId }],
    lifecycles: [state],
  });
  projection.dispose();
});

it.each([
  [{ ...state, lease: "private" }],
  [{ ...state, execution: "enabled" }],
  [{ ...state, revision: -1 }],
  [{ ...state, harnessSessionId: "../private" }],
  [state, state],
  null,
])(
  "rejects malformed or contradictory lifecycle projection %j",
  (lifecycles) => {
    expect(parseAssistantState({ ...runtime, lifecycles })).toBeNull();
  },
);
