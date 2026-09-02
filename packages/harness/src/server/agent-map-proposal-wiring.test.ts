import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

import type { BusMessage } from "../shared/types.js";
import { EventBus } from "../core/event-bus.js";
import { AgentMapProposalService } from "../core/agent-map-proposal-service.js";
import { AgentMapWorkspaceStore } from "../core/agent-map-workspace-store.js";

it("publishes exactly one accepted proposal delta after durable commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-map-wiring-"));
  const bus = new EventBus();
  const messages: BusMessage[] = [];
  bus.subscribe((message) => messages.push(message));
  const service = new AgentMapProposalService(
    new AgentMapWorkspaceStore(root),
    {
      onAccepted: (delta) =>
        bus.publish({ type: "agent-map.proposal.changed", delta }),
    },
  );
  const identity = {
    projectId: "project_00000000-0000-4000-8000-000000000001",
    userId: "user-1",
    sessionId: "session-1",
    role: "map-planner" as const,
  };
  const request = {
    schemaVersion: 1 as const,
    proposalId: null,
    expectedVersion: 0,
    requestId: "request-1",
    operations: [
      {
        kind: "add-node" as const,
        draftRef: "research" as import("../shared/agent-map.js").DraftRef,
        node: {
          kind: "agent" as const,
          name: "Research",
          purpose: "Research",
          ownerAgent: null,
          contractRefs: [],
        },
      },
    ],
  };
  const result = await service.propose(identity, request);
  await service.propose(identity, request);
  expect(messages).toEqual([
    { type: "agent-map.proposal.changed", delta: result.delta },
  ]);
  expect((await service.read(identity.projectId)).proposal?.version).toBe(1);
  await fs.rm(root, { recursive: true, force: true });
});
