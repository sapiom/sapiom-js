/**
 * Validation schema for the sandbox-preview parts of `sapiom.json`.
 *
 * Two concerns, deliberately split (see the note below) so the shared "envelope"
 * can later move to a `@sapiom/project-config` package while the sandbox resource
 * schema stays capability-owned:
 *
 *   - ENVELOPE (shared, versioned): the file's `version` + `resources` map. The
 *     format WILL evolve and be co-owned by several Sapiom-dev surfaces (agents,
 *     sandbox, later database/domain), so it carries a version the reader checks.
 *   - RESOURCE SCHEMA (capability-owned): the `type: "sandbox"` entry shape. Each
 *     capability owns/validates its own resource type; this file owns only sandbox.
 *
 * The zod schema is the single source of truth reused by: the config reader
 * (actionable read-time errors), a validate/check pass, and the MCP `configure`
 * tool's arg schema (config-as-tool-args — the agent fills typed args, never
 * hand-writes JSON).
 */
import { z } from 'zod';

/** Bump when the file envelope changes incompatibly. Readers reject a higher version. */
export const CONFIG_VERSION = 1;

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upload'), path: z.string().optional() }),
  z.object({ kind: z.literal('git'), slug: z.string().min(1), path: z.string().optional() }),
]);

/**
 * The sandbox resource body (without the `name`, which is the map key). This is
 * also the shape the MCP `configure` tool accepts as typed args.
 */
export const sandboxConfigBodySchema = z.object({
  source: sourceSchema,
  build: z.string().optional(),
  start: z.string().min(1, 'start (the server command) is required'),
  port: z.number().int().min(1).max(65535),
  tier: z.enum(['xs', 's', 'm', 'l', 'xl']).optional(),
  ttl: z.string().optional(),
  env: z.record(z.string()).optional(),
});

export type SandboxConfigBody = z.infer<typeof sandboxConfigBodySchema>;

/** The stored on-disk sandbox entry (adds the `type` discriminant). */
export const storedSandboxSchema = sandboxConfigBodySchema.extend({ type: z.literal('sandbox') });
