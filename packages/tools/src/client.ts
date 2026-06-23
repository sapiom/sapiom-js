/**
 * `createClient` — builds a `Sapiom` client whose capability namespaces are bound
 * to an explicit credential. This is the standalone / open-source entry point:
 *
 *   import { createClient } from "@sapiom/tools";
 *   const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });
 *   const box = await sapiom.sandboxes.create({ name: "demo" });
 *
 * Inside a workflow step the engine hands you an already-auth'd `sapiom` of this
 * same shape; you can also barrel-import the ambient-bound namespaces directly
 * (`import { sandboxes } from "@sapiom/tools"`).
 *
 * Attribution is set once (the engine constructs the per-execution client with
 * it; standalone callers pass it to `createClient`), never per capability call.
 * `withAttribution(...)` derives a client for the router case — see `_client`.
 */
import {
  Transport,
  attributionFromEnv,
  type TransportConfig,
  type Attribution,
} from "./_client/index.js";
import { Sandbox } from "./sandboxes/index.js";
import type { SandboxCreateOptions } from "./sandboxes/index.js";
import { Repository } from "./repositories/index.js";
import { run as codingRun, launch as codingLaunch } from "./agent/index.js";
import type {
  CodingRunSpec,
  CodingRunResult,
  RunHandle,
} from "./agent/index.js";
import * as fileStorage from "./file-storage/index.js";
import type {
  UploadInput,
  UploadResponse,
  DownloadUrlResponse,
  ListOptions,
  ListResponse,
  FileMetadata,
} from "./file-storage/index.js";
import * as fal from "./fal/index.js";
import type { FalRunInput, FalRunResponse } from "./fal/index.js";

export interface Sapiom {
  readonly sandboxes: {
    create(opts: SandboxCreateOptions): Promise<Sandbox>;
    attach(
      name: string,
      opts?: { workspaceRoot?: string; baseUrl?: string },
    ): Sandbox;
  };
  readonly repositories: {
    create(slug: string): Promise<Repository>;
    get(slug: string): Promise<Repository>;
    list(): Promise<Repository[]>;
    delete(slug: string): Promise<void>;
    attach(slug: string, cloneUrl: string): Repository;
  };
  readonly agent: {
    coding: {
      run(spec: CodingRunSpec): Promise<CodingRunResult>;
      launch(spec: CodingRunSpec): Promise<RunHandle>;
    };
  };
  readonly fileStorage: {
    upload(input: UploadInput): Promise<UploadResponse>;
    getDownloadUrl(fileId: string): Promise<DownloadUrlResponse>;
    list(opts?: ListOptions): Promise<ListResponse>;
    delete(fileId: string): Promise<void>;
    setVisibility(
      fileId: string,
      visibility: "private" | "public",
    ): Promise<FileMetadata>;
  };
  readonly fal: {
    /**
     * Run a Fal model. Pass `storage` to persist each output into file-storage
     * (the returned images then carry `file_id`).
     */
    run(input: FalRunInput): Promise<FalRunResponse>;
  };
  /**
   * Derive a client that attributes its calls to a different agent/trace. For the
   * router case (one process acting for many agents); step-authoring code doesn't
   * need this — attribution is set once when the client is constructed.
   */
  withAttribution(attribution: Attribution): Sapiom;
  // domains, scrape, search, … land here as they're ported.
}

/** Bind every capability namespace to a transport. `withAttribution` rebinds to a derived one. */
function bind(transport: Transport): Sapiom {
  return {
    sandboxes: {
      create: (opts) => Sandbox.create(opts, transport),
      attach: (name, opts) => Sandbox.attach(name, opts, transport),
    },
    repositories: {
      create: (slug) => Repository.create(slug, transport),
      get: (slug) => Repository.get(slug, transport),
      list: () => Repository.list(transport),
      delete: (slug) => Repository.delete(slug, transport),
      attach: (slug, cloneUrl) => Repository.attach(slug, cloneUrl, transport),
    },
    agent: {
      coding: {
        run: (spec) => codingRun(spec, transport),
        launch: (spec) => codingLaunch(spec, transport),
      },
    },
    fileStorage: {
      upload: (input) => fileStorage.upload(input, transport),
      getDownloadUrl: (fileId) => fileStorage.getDownloadUrl(fileId, transport),
      list: (opts) => fileStorage.list(opts, transport),
      delete: (fileId) => fileStorage.delete(fileId, transport),
      setVisibility: (fileId, visibility) =>
        fileStorage.setVisibility(fileId, visibility, transport),
    },
    fal: {
      run: (input) => fal.run(input, transport),
    },
    withAttribution: (attribution) =>
      bind(transport.withAttribution(attribution)),
  };
}

export function createClient(config?: TransportConfig): Sapiom {
  return bind(new Transport(config));
}

/**
 * Build a client from the ambient environment — credential from `SAPIOM_API_KEY`
 * and attribution from `SAPIOM_AGENT_*` / `SAPIOM_TRACE_*` — as a FRESH,
 * non-memoized transport. This is the per-execution constructor the workflow
 * runner uses to build `ctx.sapiom`: unlike the barrel's `defaultTransport()`
 * (process-global + memoized, which would bleed credentials/attribution when one
 * process serves multiple step executions), each call reads the current env, so
 * a runner constructing one per execution attributes each correctly.
 */
export function createClientFromEnv(): Sapiom {
  return bind(new Transport({ attribution: attributionFromEnv() }));
}
