import { get } from "node:http";
import { isAbsolute } from "node:path";
import {
  HOST_MESSAGE_MAX_BYTES,
  STUDIO_HOST_CONTEXT_ENV,
  STUDIO_HOST_CONTEXT_PATH,
  StudioHostBootstrapSchema,
  StudioHostContextSchema,
  type McpCapabilities,
  type StudioHostContext,
} from "@sapiom/agent-map/host-protocol";
import { describeCapabilities } from "./capabilities.js";

type Failure =
  | "invalid-bootstrap"
  | "artifact-changed"
  | "host-unavailable"
  | "scope-changed";
export type StudioHostMode =
  | { kind: "standalone" }
  | { kind: "legacy-studio" }
  | { kind: "unavailable-studio"; reason: Failure }
  | { kind: "studio"; context: StudioHostContext };

/** Numeric loopback only: no DNS, redirects, credentials in URLs or scope selectors. */
function contextEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== STUDIO_HOST_CONTEXT_PATH
  )
    throw new Error("Invalid host endpoint");
  return url;
}

function readContext(
  url: URL,
  token: string,
  timeoutMs: number,
): Promise<StudioHostContext> {
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        agent: false,
        maxHeaderSize: HOST_MESSAGE_MAX_BYTES,
        headers: { Authorization: `Bearer ${token}` },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          request.destroy(new Error("Host rejected context"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > HOST_MESSAGE_MAX_BYTES)
            request.destroy(new Error("Host response too large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const context = StudioHostContextSchema.parse(
              JSON.parse(Buffer.concat(chunks).toString("utf8")),
            );
            if (
              !isAbsolute(context.stateRoot) ||
              !context.capabilities.includes("session-context")
            )
              throw new Error("Invalid host context");
            resolve(context);
          } catch {
            reject(new Error("Invalid host context"));
          }
        });
      },
    );
    const timeout = setTimeout(
      () => request.destroy(new Error("Host timed out")),
      timeoutMs,
    );
    request.on("error", reject);
    request.on("close", () => clearTimeout(timeout));
  });
}

/** Each resolve revalidates host admission. Consumers must not treat a previously
 * returned context as authority for later writes (or arbitrary filesystem IO).
 */
export class StudioHostContextClient {
  private readonly launch: string | undefined;
  private readonly legacy: boolean;
  private pinned?: StudioHostContext;

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly describe: () => Promise<McpCapabilities> = describeCapabilities,
    private readonly timeoutMs = 2_000,
  ) {
    this.launch = env[STUDIO_HOST_CONTEXT_ENV];
    this.legacy = env.SAPIOM_HARNESS_VERSION !== undefined;
  }

  async resolve(): Promise<StudioHostMode> {
    if (this.launch === undefined)
      return { kind: this.legacy ? "legacy-studio" : "standalone" };
    let reason: Failure = "invalid-bootstrap";
    try {
      if (Buffer.byteLength(this.launch) > HOST_MESSAGE_MAX_BYTES)
        throw new Error("Bootstrap too large");
      const bootstrap = StudioHostBootstrapSchema.parse(
        JSON.parse(this.launch),
      );
      const url = contextEndpoint(bootstrap.contextUrl);
      reason = "artifact-changed";
      if (
        JSON.stringify(await this.describe()) !==
        JSON.stringify(bootstrap.expectedMcp)
      )
        throw new Error("MCP changed after preflight");
      reason = "host-unavailable";
      const context = await readContext(
        url,
        bootstrap.bearerToken,
        this.timeoutMs,
      );
      reason = "scope-changed";
      if (
        this.pinned &&
        ["projectId", "stateRoot", "userId", "sessionId", "generation"].some(
          (key) =>
            context[key as keyof StudioHostContext] !==
            this.pinned![key as keyof StudioHostContext],
        )
      )
        throw new Error("Host scope changed");
      this.pinned ??= structuredClone(context);
      return { kind: "studio", context };
    } catch {
      // Never log URLs, tokens, response bodies or schema exceptions.
      return { kind: "unavailable-studio", reason };
    }
  }
}

export const studioHostContext = new StudioHostContextClient(process.env);
