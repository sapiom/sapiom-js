import { describe, expect, it } from "vitest";
import {
  AssistantContextError,
  assistantContentHash,
  assistantRevision,
  assistantContextLimits,
  encodeAssistantContext,
} from "@sapiom/opencode";
import {
  sourceContext,
  sourceFixture,
  sourceScope,
  acceptanceId,
} from "./test-fixtures/assistant-context.js";
import {
  createAssistantSource,
  createAssistantContextCandidate,
  encodeAssistantSkillPackage,
  decodeAssistantSource,
  validateAssistantMaterials,
  acceptedAssistantRecord,
  retainAssistantGuidance,
  type SkillPackageMember,
} from "./assistant-sources.js";

const members = (): SkillPackageMember[] => [
  {
    path: "SKILL.md",
    bytes: Buffer.from("Use the bundled script.\r\n"),
    executable: false,
  },
  {
    path: "scripts/run.sh",
    bytes: Buffer.from("#!/bin/sh\nprintf done\n"),
    executable: true,
  },
  {
    path: "assets/pixel.bin",
    bytes: new Uint8Array([0, 255, 1]),
    executable: false,
  },
];
const identity = {
  id: "skill",
  kind: "skill" as const,
  required: true,
  source: "fixture:skill",
  authorityScope: sourceScope,
};

describe("retained Assistant source artifacts", () => {
  it.each(["metadata-only", "version-only", "different"])(
    "rejects inconsistent %s fallback provenance",
    (mode) => {
      const context = sourceContext();
      const fallback = { fromSource: "host:a", reason: "empty" };
      const guidance = retainAssistantGuidance(
        {
          ...context.guidance[0]!,
          ...(mode === "metadata-only" ? {} : { fallback }),
        },
        sourceScope,
      );
      if (mode === "version-only") delete guidance.metadata.fallback;
      else
        guidance.metadata.fallback =
          mode === "different"
            ? { fromSource: "host:b", reason: "offline" }
            : fallback;
      expect(() =>
        createAssistantContextCandidate(context, sourceScope, [guidance]),
      ).toThrow(AssistantContextError);
    },
  );
  it("copies the same bounded bytes reference that passed the aggregate preflight", () => {
    const context = sourceContext();
    const guidance = retainAssistantGuidance(context.guidance[0]!, sourceScope);
    const original = guidance.material!.bytes;
    const oversized = new Uint8Array(assistantContextLimits.bytes + 1);
    let reads = 0;
    Object.defineProperty(guidance.material, "bytes", {
      get: () => (++reads <= 2 ? original : oversized),
    });
    const candidate = createAssistantContextCandidate(context, sourceScope, [
      guidance,
    ]);
    expect(
      candidate.materials.find((item) => item.sourceId === guidance.version.id)
        ?.bytes,
    ).toEqual(new Uint8Array(original));
    expect(reads).toBe(1);
  });
  it.each([1, 2, 3, 4, 5, 6])(
    "returns a validated snapshot when shared bytes change at read %i",
    (at) => {
      const context = sourceContext();
      const guidance = retainAssistantGuidance(
        context.guidance[0]!,
        sourceScope,
      );
      const shared = new Uint8Array(
        new SharedArrayBuffer(guidance.material!.bytes.byteLength),
      );
      shared.set(guidance.material!.bytes);
      let reads = 0;
      // Deterministically model a concurrent writer at several snapshot boundaries.
      Object.defineProperty(guidance.material, "bytes", {
        get() {
          if (++reads === at) shared.fill(120);
          return shared;
        },
      });
      let candidate;
      try {
        candidate = createAssistantContextCandidate(context, sourceScope, [
          guidance,
        ]);
      } catch (error) {
        expect(error).toBeInstanceOf(AssistantContextError);
        return;
      }
      expect(() =>
        acceptedAssistantRecord(
          candidate,
          sourceScope,
          "ses_fixture",
          acceptanceId,
        ),
      ).not.toThrow();
    },
  );
  it("bounds supplied package allocation and rejects lossy UTF-16 guidance", () => {
    const large = {
      ...members()[0]!,
      bytes: new Uint8Array(assistantContextLimits.bytes),
    };
    expect(() => encodeAssistantSkillPackage([large])).toThrow(
      AssistantContextError,
    );
    expect(() =>
      encodeAssistantSkillPackage(
        Array(assistantContextLimits.entries + 1).fill(members()[0]),
      ),
    ).toThrow(AssistantContextError);
    expect(() =>
      createAssistantSource(identity, {
        format: "utf8",
        bytes: new Uint8Array(assistantContextLimits.bytes + 1),
      }),
    ).toThrow(AssistantContextError);
    expect(() =>
      retainAssistantGuidance(
        { ...sourceContext().guidance[0]!, text: "lone \ud800" },
        sourceScope,
      ),
    ).toThrow(AssistantContextError);
  });
  it("rejects aggregate retained material size before copying a candidate", () => {
    const context = sourceContext();
    const guidance = Array.from({ length: 3 }, (_, index) =>
      retainAssistantGuidance(
        {
          ...context.guidance[0]!,
          id: `profile-${index}`,
          text: "x".repeat(assistantContextLimits.bytes / 2),
        },
        sourceScope,
      ),
    );
    expect(() =>
      createAssistantContextCandidate(context, sourceScope, guidance),
    ).toThrow(AssistantContextError);
    const { candidate } = sourceFixture();
    const instructionSet = {
      ...candidate.instructionSet,
      sources: [
        ...candidate.instructionSet.sources,
        ...guidance.map((item) => item.version),
      ],
    };
    instructionSet.revision = assistantRevision(instructionSet);
    const oversized = [
      ...candidate.materials,
      ...guidance.map((item) => item.material!),
    ];
    expect(() =>
      validateAssistantMaterials(instructionSet, oversized, sourceScope),
    ).toThrow(AssistantContextError);
  });
  it("retains exact text and explicit scope, skill and MCP manifests", () => {
    const { candidate, accepted } = sourceFixture();
    const decoded = validateAssistantMaterials(
      candidate.instructionSet,
      candidate.materials,
      sourceScope,
    );
    expect(decoded.get("profile")).toEqual({
      format: "utf8",
      text: "Exact profile\r\nbytes",
    });
    expect(decoded.get("skillCatalogRevision")).toMatchObject({
      format: "json",
      value: { schemaVersion: 1, sources: [] },
    });
    expect(decoded.get("mcpCatalogRevision")).toMatchObject({
      format: "json",
      value: { capabilities: [{ name: "sapiom", tools: ["read"] }] },
    });
    expect(JSON.stringify(accepted)).not.toContain("Exact profile");
    expect(
      accepted.instructionSet.sources.some(
        (source) => source.kind === "policy",
      ),
    ).toBe(true);
  });
  it("detaches facts, provider versions and material buffers before later mutation", () => {
    const context = sourceContext();
    const guidance = context.guidance.map((source) =>
      retainAssistantGuidance(source, sourceScope),
    );
    const candidate = createAssistantContextCandidate(
      context,
      sourceScope,
      guidance,
    );
    const saved = acceptedAssistantRecord(
      candidate,
      sourceScope,
      "ses_fixture",
      acceptanceId,
    );
    context.environment = "changed";
    context.guidance[0]!.text = "changed";
    guidance[0]!.material!.bytes.fill(0);
    (guidance[0]!.version as { source: string }).source = "changed";
    expect(
      acceptedAssistantRecord(
        candidate,
        sourceScope,
        "ses_fixture",
        acceptanceId,
      ),
    ).toEqual(saved);
  });
  it("distinguishes bytes, provenance, absence and acceptance identity", () => {
    const input = Buffer.from("a\r\n");
    const source = createAssistantSource(identity, {
      format: "utf8",
      bytes: input,
    });
    input.fill(0);
    expect(source.version.contentHash).toBe(assistantContentHash("a\r\n"));
    expect(
      createAssistantSource(identity, {
        format: "utf8",
        bytes: Buffer.from("a\n"),
      }).version.revision,
    ).not.toBe(source.version.revision);
    const fallback = createAssistantSource(
      { ...identity, fallback: { fromSource: "served", reason: "offline" } },
      { format: "utf8", bytes: Buffer.from("a\r\n") },
    );
    expect(fallback.version.contentHash).toBe(source.version.contentHash);
    expect(fallback.version.revision).not.toBe(source.version.revision);
    const absent = createAssistantSource(
      { ...identity, required: false },
      { status: "not-configured", reason: "Loader not connected" },
    );
    expect(absent).toMatchObject({
      version: { status: "not-configured", contentHash: null },
    });
    expect(absent.material).toBeUndefined();
    expect(() =>
      createAssistantSource(identity, {
        status: "unavailable",
        reason: "Failed",
      }),
    ).toThrow(AssistantContextError);
  });
  it("preserves package resources and executable facts independently of live inputs", () => {
    const inputs = members();
    const bytes = encodeAssistantSkillPackage(inputs);
    const reversed = encodeAssistantSkillPackage([...inputs].reverse());
    expect(reversed).toEqual(bytes);
    inputs[1]!.bytes.fill(0);
    const content = decodeAssistantSource("skill-package", bytes);
    if (content.format !== "skill-package") throw new Error("Expected package");
    expect(content.members.map((member) => member.path)).toEqual([
      "SKILL.md",
      "assets/pixel.bin",
      "scripts/run.sh",
    ]);
    expect(content.members[1]!.bytes).toEqual(new Uint8Array([0, 255, 1]));
    expect(content.members[2]!.executable).toBe(true);
    expect(Buffer.from(content.members[2]!.bytes).toString()).toContain(
      "printf done",
    );
    content.members[1]!.bytes.fill(0);
    expect(decodeAssistantSource("skill-package", bytes)).not.toEqual(content);
  });
  it.each([
    "/absolute",
    "../escape",
    "a/../escape",
    "a\\b",
    "C:/drive",
    "./file",
    "a//b",
    "a/",
    "a\u0000b",
    "assets/input?.txt",
    "star*",
    'a"b',
    "a<b",
    "a>b",
    "a|b",
    "trailing.",
    "trailing ",
    "CON.txt",
    "nested/com1/script",
    "NUL",
    "LPT9.log",
  ])("rejects nonportable package member %j", (path) => {
    expect(() =>
      encodeAssistantSkillPackage([
        ...members(),
        { path, bytes: Buffer.from("x"), executable: false },
      ]),
    ).toThrow(AssistantContextError);
  });
  it("rejects missing entrypoints, collisions, links, bad bytes and changed member hashes", () => {
    expect(() =>
      encodeAssistantSkillPackage([
        ...members(),
        { path: "skill.md/nested", bytes: Buffer.from("x"), executable: false },
      ]),
    ).toThrow(AssistantContextError);
    expect(() => encodeAssistantSkillPackage(members().slice(1))).toThrow(
      AssistantContextError,
    );
    expect(() =>
      encodeAssistantSkillPackage([
        ...members(),
        { ...members()[0]!, path: "skill.md" },
      ]),
    ).toThrow(AssistantContextError);
    expect(() =>
      encodeAssistantSkillPackage([
        { ...members()[0]!, target: "/live" } as SkillPackageMember,
      ]),
    ).toThrow(AssistantContextError);
    const artifact = JSON.parse(
      Buffer.from(encodeAssistantSkillPackage(members())).toString(),
    );
    for (const value of ["!!", "YQ", "YQ=="]) {
      artifact.members[0].contentBase64 = value;
      expect(() =>
        decodeAssistantSource(
          "skill-package",
          Buffer.from(encodeAssistantContext(artifact)),
        ),
      ).toThrow(AssistantContextError);
    }
    expect(() => decodeAssistantSource("utf8", new Uint8Array([255]))).toThrow(
      AssistantContextError,
    );
    expect(
      decodeAssistantSource("utf8", Buffer.from("\ufeffexact\r\n")),
    ).toEqual({ format: "utf8", text: "\ufeffexact\r\n" });
  });
  it("requires every accepted available object even when its source was optional", () => {
    const context = sourceContext();
    context.guidance[0]!.required = false;
    // A separate required profile preserves the mandatory profile invariant.
    context.guidance.push({
      ...context.guidance[0]!,
      id: "required-profile",
      required: true,
    });
    const candidate = createAssistantContextCandidate(context, sourceScope);
    const without = candidate.materials.filter(
      (item) => item.sourceId !== "profile",
    );
    expect(() =>
      validateAssistantMaterials(
        candidate.instructionSet,
        without,
        sourceScope,
      ),
    ).toThrow(AssistantContextError);
    expect(() =>
      validateAssistantMaterials(
        candidate.instructionSet,
        candidate.materials,
        "b".repeat(64),
      ),
    ).toThrow(AssistantContextError);
    expect(() =>
      retainAssistantGuidance(
        { ...context.guidance[0]!, location: "/mutable" },
        sourceScope,
      ),
    ).toThrow(AssistantContextError);
  });
  it("accepts complete skill artifacts through the typed provider seam", () => {
    const context = sourceContext();
    const skill = createAssistantSource(identity, {
      format: "skill-package",
      bytes: encodeAssistantSkillPackage(members()),
    });
    const candidate = createAssistantContextCandidate(context, sourceScope, [
      retainAssistantGuidance(context.guidance[0]!, sourceScope),
      {
        ...skill,
        metadata: {
          id: "skill",
          kind: "skill",
          required: true,
          source: identity.source,
          revision: null,
          status: "available",
        },
      },
    ]);
    expect(
      validateAssistantMaterials(
        candidate.instructionSet,
        candidate.materials,
        sourceScope,
      ).get("skill"),
    ).toMatchObject({ format: "skill-package", entrypoint: "SKILL.md" });
    const accepted = acceptedAssistantRecord(
      candidate,
      sourceScope,
      "ses_fixture",
      acceptanceId,
    );
    expect(accepted.instructionSet.skillCatalogRevision).not.toBe(
      sourceFixture().accepted.instructionSet.skillCatalogRevision,
    );
  });
});
