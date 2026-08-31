import {
  PACKAGE_INVENTORY_PROTOCOL,
  packageInventorySchema,
  type PackageInventory,
  type PackageInventoryIdentityIssue,
} from "./index.js";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;

function workingTree(
  overrides: Partial<PackageInventory> = {},
): PackageInventory {
  return {
    protocol: PACKAGE_INVENTORY_PROTOCOL,
    version: {
      kind: "working-tree",
      workspaceKey: "workspace-acme",
      revision: SHA_A,
    },
    status: "complete",
    agents: [
      {
        agentKey: "Research",
        identityStatus: "canonical",
        path: "agents/research",
        entrypoint: "index.ts",
      },
    ],
    ...overrides,
  };
}

describe("packageInventorySchema", () => {
  it("parses working-tree and bundle inventories and sorts agents deterministically", () => {
    const agents = [
      {
        agentKey: "zeta",
        identityStatus: "canonical" as const,
        path: "zeta",
        entrypoint: "index.ts",
      },
      {
        agentKey: "Alpha",
        identityStatus: "canonical" as const,
        path: ".",
        entrypoint: "src/index.ts",
      },
    ];
    const working = packageInventorySchema.parse(
      workingTree({ agents: [...agents].reverse() }),
    );
    const equivalent = packageInventorySchema.parse(workingTree({ agents }));

    expect(working.agents.map((agent) => agent.agentKey)).toEqual([
      "Alpha",
      "zeta",
    ]);
    expect(working.agents).toEqual(equivalent.agents);
    expect(
      packageInventorySchema.parse({
        protocol: 1,
        version: { kind: "bundle", bundleDigest: SHA_B },
        status: "complete",
        agents,
      }).version,
    ).toEqual({ kind: "bundle", bundleDigest: SHA_B });
  });

  it("accepts a degraded working tree with a safe provisional identity", () => {
    expect(
      packageInventorySchema.parse(
        workingTree({
          status: "degraded",
          agents: [
            {
              agentKey: "local:agents/research",
              identityStatus: "provisional",
              identityIssue: "identity-pending",
              path: "agents/research",
              entrypoint: "index.ts",
            },
          ],
        }),
      ).status,
    ).toBe("degraded");
  });

  it.each(["local:C:", "local:C:/agent"])(
    "rejects Windows drive-shaped provisional key %j",
    (agentKey) => {
      expect(() =>
        packageInventorySchema.parse(
          workingTree({
            status: "degraded",
            agents: [
              {
                agentKey,
                identityStatus: "provisional",
                identityIssue: "identity-unavailable",
                path: "agent",
                entrypoint: "index.ts",
              },
            ],
          }),
        ),
      ).toThrow();
    },
  );

  it.each([
    "",
    "  agent",
    "agent  ",
    ".",
    "..",
    "agents/research",
    "agents\\research",
    "/absolute",
    "local:reserved",
    "control\nname",
    "control\u0085name",
    "control\u009fname",
  ])("rejects unsafe canonical name %j", (agentKey) => {
    expect(() =>
      packageInventorySchema.parse(
        workingTree({
          agents: [
            {
              agentKey,
              identityStatus: "canonical",
              path: ".",
              entrypoint: "index.ts",
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it.each([
    "sha256:ABCDEF",
    `sha256:${"A".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    "a".repeat(64),
  ])("rejects invalid digest %j", (revision) => {
    expect(() =>
      packageInventorySchema.parse(
        workingTree({
          version: {
            kind: "working-tree",
            workspaceKey: "workspace-acme",
            revision: revision as `sha256:${string}`,
          },
        }),
      ),
    ).toThrow();
  });

  it.each([
    { path: "", entrypoint: "index.ts" },
    { path: "/absolute", entrypoint: "index.ts" },
    { path: "C:/absolute", entrypoint: "index.ts" },
    { path: "agents\\research", entrypoint: "index.ts" },
    { path: "agents/../research", entrypoint: "index.ts" },
    { path: ".", entrypoint: "../index.ts" },
    { path: ".", entrypoint: "/index.ts" },
    { path: ".", entrypoint: "C:/index.ts" },
    { path: ".", entrypoint: "." },
  ])(
    "rejects unsafe relative location $path/$entrypoint",
    ({ path, entrypoint }) => {
      expect(() =>
        packageInventorySchema.parse(
          workingTree({
            agents: [
              {
                agentKey: "research",
                identityStatus: "canonical",
                path,
                entrypoint,
              },
            ],
          }),
        ),
      ).toThrow();
    },
  );

  it("rejects duplicate keys and duplicate path/entrypoint pairs", () => {
    const base = workingTree().agents[0]!;
    expect(() =>
      packageInventorySchema.parse(
        workingTree({ agents: [base, { ...base, path: "copy" }] }),
      ),
    ).toThrow(/Duplicate agentKey/);
    expect(() =>
      packageInventorySchema.parse(
        workingTree({ agents: [base, { ...base, agentKey: "growth" }] }),
      ),
    ).toThrow(/Duplicate agent path/);
  });

  it("rejects complete provisional inventories and every degraded bundle", () => {
    const provisional = workingTree({
      status: "degraded",
      agents: [
        {
          agentKey: "local:research",
          identityStatus: "provisional",
          identityIssue: "identity-unavailable",
          path: "research",
          entrypoint: "index.ts",
        },
      ],
    });
    expect(() =>
      packageInventorySchema.parse({ ...provisional, status: "complete" }),
    ).toThrow(/provisional identities must be degraded/);
    expect(() =>
      packageInventorySchema.parse({
        ...provisional,
        version: { kind: "bundle", bundleDigest: SHA_B },
      }),
    ).toThrow(/bundle inventory/);
    expect(() =>
      packageInventorySchema.parse({
        ...workingTree({ status: "degraded" }),
        version: { kind: "bundle", bundleDigest: SHA_B },
      }),
    ).toThrow(/bundle inventory/);
  });

  it("accepts degraded working trees with canonical-only or empty rows", () => {
    expect(
      packageInventorySchema.parse(workingTree({ status: "degraded" })).status,
    ).toBe("degraded");
    expect(
      packageInventorySchema.parse(
        workingTree({ status: "degraded", agents: [] }),
      ).agents,
    ).toEqual([]);
  });

  it("requires duplicate provisional records to retain their safe candidate", () => {
    const duplicate = {
      agentKey: "local:research-a",
      identityStatus: "provisional" as const,
      identityIssue: "duplicate-agent-key" as const,
      path: "research-a",
      entrypoint: "index.ts",
    };
    expect(() =>
      packageInventorySchema.parse(
        workingTree({ status: "degraded", agents: [duplicate] as never }),
      ),
    ).toThrow(/ambiguous candidate/);
    expect(
      packageInventorySchema.parse(
        workingTree({
          status: "degraded",
          agents: [{ ...duplicate, candidateAgentKey: "research" }],
        }),
      ).agents[0]?.candidateAgentKey,
    ).toBe("research");
  });

  it.each([
    {
      agentKey: "research",
      identityStatus: "canonical",
      identityIssue: "identity-pending",
      path: "research",
      entrypoint: "index.ts",
    },
    {
      agentKey: "research",
      identityStatus: "canonical",
      candidateAgentKey: "candidate",
      path: "research",
      entrypoint: "index.ts",
    },
    {
      agentKey: "local:research",
      identityStatus: "canonical",
      path: "research",
      entrypoint: "index.ts",
    },
    {
      agentKey: "local:research",
      identityStatus: "provisional",
      path: "research",
      entrypoint: "index.ts",
    },
    {
      agentKey: "local:research",
      identityStatus: "provisional",
      identityIssue: "identity-pending",
      candidateAgentKey: "research",
      path: "research",
      entrypoint: "index.ts",
    },
  ])("rejects inconsistent identity state %#", (agent) => {
    expect(() =>
      packageInventorySchema.parse(
        workingTree({ status: "degraded", agents: [agent] as never }),
      ),
    ).toThrow();
  });
});

describe("package inventory public type surface", () => {
  it("exports the provisional identity reasons for exhaustive consumers", () => {
    const reasons: PackageInventoryIdentityIssue[] = [
      "identity-pending",
      "identity-unavailable",
      "identity-invalid",
      "duplicate-agent-key",
    ];

    expect(reasons).toHaveLength(4);
  });
});
