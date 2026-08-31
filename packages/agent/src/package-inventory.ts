// `zod/v4` is available from both supported peer ranges (Zod 3.25 and 4.x).
import { z } from "zod/v4";

/** Protocol version for the package inventory exchanged by build and Studio tooling. */
export const PACKAGE_INVENTORY_PROTOCOL = 1 as const;

export type PackageInventoryVersion =
  | {
      /** Mutable checkout identity plus its normalized public-content revision. */
      readonly kind: "working-tree";
      readonly workspaceKey: string;
      readonly revision: `sha256:${string}`;
    }
  | {
      /**
       * Immutable uploaded-package identity. `bundleDigest` names the exact
       * bundle whose inventory was derived; protocol 1 bundle inventories are
       * complete snapshots and are rejected when marked degraded.
       */
      readonly kind: "bundle";
      readonly bundleDigest: `sha256:${string}`;
    };

/** Why a package-inventory identity is provisional. */
export type PackageInventoryIdentityIssue =
  | "identity-pending"
  | "identity-unavailable"
  | "identity-invalid"
  | "duplicate-agent-key";

interface PackageInventoryAgentBase {
  readonly agentKey: string;
  /** POSIX, package-root-relative directory (`.` denotes the package root). */
  readonly path: string;
  /** POSIX path relative to the agent directory. */
  readonly entrypoint: string;
}

export type PackageInventoryAgent = PackageInventoryAgentBase &
  (
    | {
        readonly identityStatus: "canonical";
        readonly identityIssue?: never;
        readonly candidateAgentKey?: never;
      }
    | {
        readonly identityStatus: "provisional";
        readonly identityIssue: Exclude<
          PackageInventoryIdentityIssue,
          "duplicate-agent-key"
        >;
        readonly candidateAgentKey?: never;
      }
    | {
        readonly identityStatus: "provisional";
        readonly identityIssue: "duplicate-agent-key";
        readonly candidateAgentKey: string;
      }
  );

/**
 * Describes which agents exist in a package, their stable identities, and
 * package-relative locations only.
 *
 * Future factual agent profiles and cross-agent relationships will use
 * separately versioned contracts.
 */
export interface PackageInventory {
  readonly protocol: typeof PACKAGE_INVENTORY_PROTOCOL;
  readonly version: PackageInventoryVersion;
  readonly status: "complete" | "degraded";
  readonly agents: readonly PackageInventoryAgent[];
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function canonicalAgentKey(value: string): boolean {
  return (
    value !== "" &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("local:") &&
    !hasControlCharacter(value) &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function provisionalAgentKey(value: string): boolean {
  if (canonicalAgentKey(value)) return true;
  if (
    !value.startsWith("local:") ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  const relative = value.slice("local:".length);
  return (
    relative !== "" &&
    !/^[A-Za-z]:(?:$|\/)/.test(relative) &&
    !relative.includes("\\") &&
    relative
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function relativePosixPath(value: string, allowRoot: boolean): boolean {
  if (allowRoot && value === ".") return true;
  if (
    value === "" ||
    value !== value.trim() ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value) ||
    value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const digestSchema = z
  .string()
  .regex(SHA256, "Expected lowercase sha256:<64 hex characters>")
  .transform((value) => value as `sha256:${string}`);
const canonicalAgentKeySchema = z
  .string()
  .refine(canonicalAgentKey, "Expected a safe canonical agent key");
const provisionalAgentKeySchema = z
  .string()
  .refine(provisionalAgentKey, "Expected a safe package inventory agent key");
const packagePathSchema = z
  .string()
  .refine(
    (value) => relativePosixPath(value, true),
    "Expected a package-root-relative POSIX path",
  );
const entrypointSchema = z
  .string()
  .refine(
    (value) => relativePosixPath(value, false),
    "Expected an agent-root-relative POSIX path",
  );

const packageInventoryAgentSchema = z
  .object({
    agentKey: provisionalAgentKeySchema,
    identityStatus: z.enum(["canonical", "provisional"]),
    identityIssue: z
      .enum([
        "identity-pending",
        "identity-unavailable",
        "identity-invalid",
        "duplicate-agent-key",
      ])
      .optional(),
    candidateAgentKey: canonicalAgentKeySchema.optional(),
    path: packagePathSchema,
    entrypoint: entrypointSchema,
  })
  .strict()
  .superRefine((agent, context) => {
    if (agent.identityStatus === "canonical") {
      if (!canonicalAgentKey(agent.agentKey)) {
        context.addIssue({
          code: "custom",
          path: ["agentKey"],
          message: "A canonical inventory agent requires a canonical agent key",
        });
      }
      if (
        agent.identityIssue !== undefined ||
        agent.candidateAgentKey !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message:
            "A canonical inventory agent cannot carry provisional identity metadata",
        });
      }
      return;
    }
    if (agent.identityIssue === undefined) {
      context.addIssue({
        code: "custom",
        path: ["identityIssue"],
        message: "A provisional inventory agent requires an identity issue",
      });
    }
    if (
      agent.identityIssue === "duplicate-agent-key" &&
      agent.candidateAgentKey === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidateAgentKey"],
        message: "A duplicate identity requires its ambiguous candidate key",
      });
    }
    if (
      agent.identityIssue !== "duplicate-agent-key" &&
      agent.candidateAgentKey !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidateAgentKey"],
        message: "Only a duplicate identity can carry a candidate key",
      });
    }
  });

export const packageInventoryVersionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("working-tree"),
      workspaceKey: z.string().trim().min(1),
      revision: digestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("bundle"),
      bundleDigest: digestSchema,
    })
    .strict(),
]);

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Strict parser and normalizer for package inventory protocol 1.
 *
 * Parsing sorts agents by identity and location so every consumer sees one
 * deterministic representation. It intentionally does not alter paths or
 * identities: non-canonical spellings are rejected instead of silently
 * changing package identity.
 */
export const packageInventorySchema: z.ZodType<PackageInventory> = z
  .object({
    protocol: z.literal(PACKAGE_INVENTORY_PROTOCOL),
    version: packageInventoryVersionSchema,
    status: z.enum(["complete", "degraded"]),
    agents: z.array(packageInventoryAgentSchema),
  })
  .strict()
  .superRefine((inventory, context) => {
    const agentKeys = new Set<string>();
    const entrypoints = new Set<string>();
    for (const [index, agent] of inventory.agents.entries()) {
      if (agentKeys.has(agent.agentKey)) {
        context.addIssue({
          code: "custom",
          path: ["agents", index, "agentKey"],
          message: `Duplicate agentKey: ${agent.agentKey}`,
        });
      }
      agentKeys.add(agent.agentKey);
      const entrypointKey = `${agent.path}\u0000${agent.entrypoint}`;
      if (entrypoints.has(entrypointKey)) {
        context.addIssue({
          code: "custom",
          path: ["agents", index, "entrypoint"],
          message: "Duplicate agent path and entrypoint",
        });
      }
      entrypoints.add(entrypointKey);
    }

    const hasProvisional = inventory.agents.some(
      (agent) => agent.identityStatus === "provisional",
    );
    if (hasProvisional && inventory.status !== "degraded") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "An inventory with provisional identities must be degraded",
      });
    }
    if (
      inventory.version.kind === "bundle" &&
      (hasProvisional || inventory.status !== "complete")
    ) {
      context.addIssue({
        code: "custom",
        path: ["agents"],
        message:
          "A bundle inventory must be complete and contain only canonical identities",
      });
    }
  })
  .transform(
    (inventory) =>
      ({
        ...inventory,
        agents: [...inventory.agents].sort(
          (left, right) =>
            compareText(left.agentKey, right.agentKey) ||
            compareText(left.path, right.path) ||
            compareText(left.entrypoint, right.entrypoint),
        ),
      }) as PackageInventory,
  );
