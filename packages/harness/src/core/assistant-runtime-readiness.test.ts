import { expect, it } from "vitest";
import { assertAssistantRuntimeReady } from "./assistant-runtime-readiness.js";
import {
  sourceFixture,
  sourceScope,
} from "./test-fixtures/assistant-context.js";
import {
  createAssistantContextCandidate,
  createAssistantSource,
  encodeAssistantSkillPackage,
  retainAssistantGuidance,
  acceptedAssistantRecord,
  validateAssistantMaterials,
} from "./assistant-sources.js";

it("permits verified inline material and rejects missing readback", () => {
  const { accepted, candidate } = sourceFixture();
  const sources = validateAssistantMaterials(
    candidate.instructionSet,
    candidate.materials,
    sourceScope,
  );
  expect(() =>
    assertAssistantRuntimeReady({ accepted, sources }),
  ).not.toThrow();
  expect(() =>
    assertAssistantRuntimeReady({ accepted, sources: new Map() }),
  ).toThrow("context");
});
it.each([true, false])(
  "rejects an accepted package without a prepared generation, required=%s",
  (required) => {
    const { candidate: original, accepted } = sourceFixture();
    const source = createAssistantSource(
      {
        id: "skill",
        kind: "skill",
        source: "fixture:package",
        required,
        authorityScope: sourceScope,
      },
      {
        format: "skill-package",
        bytes: encodeAssistantSkillPackage([
          {
            path: "SKILL.md",
            bytes: Buffer.from("Required generation"),
            executable: false,
          },
        ]),
      },
    );
    const candidate = createAssistantContextCandidate(
      original.context,
      sourceScope,
      [
        ...original.context.guidance.map((source) =>
          retainAssistantGuidance(source, sourceScope),
        ),
        {
          ...source,
          metadata: {
            id: "skill",
            kind: "skill",
            required,
            source: "fixture:package",
            status: "available",
            revision: "label",
          },
        },
      ],
    );
    const record = acceptedAssistantRecord(
      candidate,
      sourceScope,
      accepted.conversationId,
      accepted.acceptanceId,
    );
    const sources = validateAssistantMaterials(
      record.instructionSet,
      candidate.materials,
      sourceScope,
    );
    expect(() =>
      assertAssistantRuntimeReady({ accepted: record, sources }),
    ).toThrow("context");
  },
);
