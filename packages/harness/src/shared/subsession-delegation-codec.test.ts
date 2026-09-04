import { describe, expect, it } from "vitest";

import {
  computeCanonicalDelegationBindingDigest,
  computeCanonicalDelegationRequestDigest,
  parseProjectSubsessionRequest,
  SubsessionDelegationValidationError,
} from "./subsession-delegation-codec.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const map = {
  projectId,
  versionId: "mapv_018f0000-0000-7000-8000-000000000001",
  contentDigest: `sha256:${"1".repeat(64)}`,
};
const plan = {
  projectId,
  planId: "plan_018f0000-0000-7000-8000-000000000002",
  versionId: "planv_018f0000-0000-7000-8000-000000000003",
  semanticDigest: `sha256:${"2".repeat(64)}`,
};

const request = (delegations: unknown[]) => ({
  schemaVersion: 1,
  requestKey: "request-1",
  operation: { kind: "delegate", delegations },
});

describe("subsession delegation codec", () => {
  it("normalizes text and canonicalizes batch order before hashing", () => {
    const left = parseProjectSubsessionRequest(
      request([
        {
          delegationKey: "publisher",
          outcome: "Publish e\u0301vidence\r\nwithout changing scope",
          focus: {
            kind: "assignment",
            map,
            plan,
            assignmentId: "work_018f0000-0000-7000-8000-000000000004",
          },
        },
        { delegationKey: "research", outcome: "Collect evidence" },
      ]),
      projectId,
    );
    const right = parseProjectSubsessionRequest(
      request([
        { delegationKey: "research", outcome: "Collect evidence" },
        {
          delegationKey: "publisher",
          outcome: "Publish évidence\nwithout changing scope",
          focus: {
            kind: "assignment",
            map,
            plan,
            assignmentId: "work_018f0000-0000-7000-8000-000000000004",
          },
        },
      ]),
      projectId,
    );

    expect(left).toEqual(right);
    expect(computeCanonicalDelegationRequestDigest(left)).toBe(
      computeCanonicalDelegationRequestDigest(right),
    );
    expect(left.operation.kind).toBe("delegate");
    if (left.operation.kind === "delegate") {
      expect(left.operation.delegations.map((entry) => entry.delegationKey)).toEqual([
        "publisher",
        "research",
      ]);
    }
  });

  it("separates request identity from immutable binding content", () => {
    const first = parseProjectSubsessionRequest(
      request([{ delegationKey: "research", outcome: "Collect evidence" }]),
      projectId,
    );
    const second = parseProjectSubsessionRequest(
      {
        ...request([
          { delegationKey: "research", outcome: "Collect evidence" },
        ]),
        requestKey: "request-2",
      },
      projectId,
    );
    expect(computeCanonicalDelegationRequestDigest(first)).not.toBe(
      computeCanonicalDelegationRequestDigest(second),
    );
    if (first.operation.kind !== "delegate" || second.operation.kind !== "delegate")
      throw new Error("unexpected operation");
    expect(
      computeCanonicalDelegationBindingDigest(first.operation.delegations[0]!),
    ).toBe(
      computeCanonicalDelegationBindingDigest(second.operation.delegations[0]!),
    );
  });

  it.each([
    ["empty batch", request([]), "capacity_exceeded"],
    [
      "duplicate keys",
      request([
        { delegationKey: "same", outcome: "First" },
        { delegationKey: "same", outcome: "Second" },
      ]),
      "invalid_request",
    ],
    [
      "separator in key",
      request([{ delegationKey: "parent/child", outcome: "Do work" }]),
      "invalid_request",
    ],
    [
      "oversized outcome",
      request([{ delegationKey: "large", outcome: "x".repeat(4_097) }]),
      "invalid_request",
    ],
    [
      "unsupported schema",
      { ...request([{ delegationKey: "one", outcome: "Do work" }]), schemaVersion: 2 },
      "unsupported_schema",
    ],
  ])("rejects %s before side effects", (_name, input, code) => {
    expect(() => parseProjectSubsessionRequest(input, projectId)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects exact focus from another project", () => {
    let error: unknown;
    try {
      parseProjectSubsessionRequest(
        request([
          {
            delegationKey: "foreign",
            outcome: "Do work",
            focus: {
              kind: "map-node",
              map: { ...map, projectId: "project_foreign" },
              plan: null,
              nodeId: "node_018f0000-0000-7000-8000-000000000005",
            },
          },
        ]),
        projectId,
      );
    } catch (failure) {
      error = failure;
    }
    expect(error).toBeInstanceOf(SubsessionDelegationValidationError);
    expect(error).toMatchObject({
      code: "invalid_request",
      issues: [{ code: "invalid_or_cross_project_focus" }],
    });
  });

  it("accepts an exact self refresh without granting arbitrary session selection", () => {
    expect(
      parseProjectSubsessionRequest(
        {
          schemaVersion: 1,
          requestKey: "refresh-1",
          operation: {
            kind: "refresh-focused-context",
            target: { kind: "self" },
            expectedContextEpoch: 2,
            expectedContextDigest: `sha256:${"3".repeat(64)}`,
            focus: null,
          },
        },
        projectId,
      ),
    ).toMatchObject({
      operation: {
        target: { kind: "self" },
        expectedContextEpoch: 2,
      },
    });
  });
});

