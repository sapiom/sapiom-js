/**
 * The MCP server `instructions` string, returned during the `initialize` handshake.
 * Capable MCP clients surface it to the model on connect, so an agent that adds this
 * server gets an agent-authoring primer without any extra setup.
 *
 * This module re-exports the BUNDLED SNAPSHOT: at startup the server fetches the live
 * copy from `GET {apiURL}/v1/mcp/instructions` and serves that, falls back to the
 * last body it fetched successfully, and serves this constant only when neither is
 * available (see instructions-fetch.ts). The snapshot is generated from the served
 * endpoint by `scripts/mcp-instructions-snapshot.mjs` as a release step, and carries
 * the content release and digest it was taken from.
 *
 * Kept intentionally short — it stays in the model's context for the whole session.
 * Deep authoring guidance lives in the scaffold-shipped `sapiom-agent-authoring`
 * skill and `AGENTS.md`, and the full reference on docs.sapiom.ai; this primer
 * points there rather than restating them.
 */
export {
  AUTHORING_INSTRUCTIONS,
  AUTHORING_INSTRUCTIONS_DIGEST,
  AUTHORING_INSTRUCTIONS_RELEASE,
} from "./instructions.generated.js";
