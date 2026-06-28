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
import {
  Sandbox,
  deploy as deploySandbox,
  createPreview as createSandboxPreview,
} from "./sandboxes/index.js";
import type {
  SandboxCreateOptions,
  DeployInput,
  DeployResult,
  PreviewInput,
  PreviewResult,
} from "./sandboxes/index.js";
import { Repository } from "./repositories/index.js";
import { run as codingRun, launch as codingLaunch } from "./agent/index.js";
import type {
  CodingRunSpec,
  CodingRunResult,
  RunHandle,
} from "./agent/index.js";
import {
  run as orchestrationsRun,
  launch as orchestrationsLaunch,
} from "./orchestrations/index.js";
import type {
  OrchestrationRunSpec,
  OrchestrationRunResult,
  RunHandle as OrchestrationRunHandle,
} from "./orchestrations/index.js";
import * as fileStorage from "./file-storage/index.js";
import type {
  UploadInput,
  UploadResponse,
  DownloadUrlResponse,
  ListOptions,
  ListResponse,
  FileMetadata,
} from "./file-storage/index.js";
import * as contentGeneration from "./content-generation/index.js";
import type {
  ImageCreateInput,
  ImageGenerationResult,
  VideoCreateInput,
  VideoGenerationResult,
  VideoLaunchHandle,
} from "./content-generation/index.js";
import {
  scrape,
  webSearch,
  findEmail,
  verifyEmail,
  domainSearch,
} from "./search/index.js";
import type {
  ScrapeInput,
  ScrapeResult,
  WebSearchInput,
  WebSearchResponse,
  FindEmailInput,
  FindEmailResult,
  VerifyEmailInput,
  VerifyEmailResult,
  DomainSearchInput,
  DomainSearchResult,
} from "./search/index.js";
import * as memory from "./memory/index.js";
import type {
  AppendInput,
  AppendResult,
  RecallInput,
  RecallResponse,
  Memory,
} from "./memory/index.js";
import * as database from "./database/index.js";
import type { CreateDatabaseInput, Database } from "./database/index.js";

export interface Sapiom {
  readonly sandboxes: {
    create(opts: SandboxCreateOptions): Promise<Sandbox>;
    attach(
      name: string,
      opts?: { workspaceRoot?: string; baseUrl?: string },
    ): Sandbox;
    /**
     * Deploy files to an existing sandbox and start the app. Returns the public
     * URL when the gateway has previews enabled. Sandbox-scoped — pass `name`.
     */
    deploy(input: DeployInput): Promise<DeployResult>;
    /** Create a public preview URL for a port on an existing sandbox. Sandbox-scoped — pass `name`. */
    createPreview(input: PreviewInput): Promise<PreviewResult>;
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
  readonly orchestrations: {
    /** Run a deployed orchestration by slug and await its terminal result. */
    run(spec: OrchestrationRunSpec): Promise<OrchestrationRunResult>;
    /** Launch a deployed orchestration; pass the handle to `pauseUntilSignal` to suspend on it. */
    launch(spec: OrchestrationRunSpec): Promise<OrchestrationRunHandle>;
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
  readonly contentGeneration: {
    images: {
      /**
       * Generate image(s) from a prompt. Pass `storage` to persist each output into
       * file-storage (the returned images then carry `file_id`).
       */
      create(input: ImageCreateInput): Promise<ImageGenerationResult>;
    };
    video: {
      /**
       * Generate a video from a prompt — async (submits, then polls until ready, then
       * returns it). Pass `storage` to persist the output (the returned video carries
       * `fileId`).
       */
      create(input: VideoCreateInput): Promise<VideoGenerationResult>;
      /**
       * Submit a video generation job and return a dispatchable handle immediately.
       * Pass the handle to `pauseUntilSignal(handle, { resumeStep })` to suspend the
       * workflow step until the video is ready, or call `handle.wait()` to block
       * inline (equivalent to `video.create`). Pass `storage` to persist the output.
       */
      launch(input: VideoCreateInput): Promise<VideoLaunchHandle>;
    };
  };
  readonly memory: {
    append(input: AppendInput): Promise<AppendResult>;
    recall(input: RecallInput): Promise<RecallResponse>;
    get(id: string): Promise<Memory>;
    forget(id: string): Promise<void>;
  };
  /**
   * Search the web, read pages, and look up professional emails. More operations
   * are added to this namespace as they ship.
   */
  readonly search: {
    /** Read a page and return its content (markdown by default). */
    scrape(input: ScrapeInput): Promise<ScrapeResult>;
    /** Search the web — a synthesized answer plus results by default. */
    webSearch(input: WebSearchInput): Promise<WebSearchResponse>;
    /** Find, verify, and discover professional email addresses. */
    readonly emailSearch: {
      /** Find a person's email from their name and company. */
      findEmail(input: FindEmailInput): Promise<FindEmailResult>;
      /** Verify that an email address is deliverable. */
      verifyEmail(input: VerifyEmailInput): Promise<VerifyEmailResult>;
      /** Discover the emails published at a company domain. */
      domainSearch(input: DomainSearchInput): Promise<DomainSearchResult>;
    };
  };
  /** On-demand Postgres databases, returned with direct connection credentials. */
  readonly database: {
    /** Provision a database (returns connection credentials). `duration` is required. */
    create(input: CreateDatabaseInput): Promise<Database>;
    /** Retrieve a database by its id or handle. */
    get(idOrHandle: string): Promise<Database>;
    /** Delete a database by its id or handle. */
    delete(idOrHandle: string): Promise<void>;
  };
  /**
   * Derive a client that attributes its calls to a different agent/trace. For the
   * router case (one process acting for many agents); step-authoring code doesn't
   * need this — attribution is set once when the client is constructed.
   */
  withAttribution(attribution: Attribution): Sapiom;
  // domains, … land here as they're ported.
}

/** Bind every capability namespace to a transport. `withAttribution` rebinds to a derived one. */
function bind(transport: Transport): Sapiom {
  return {
    sandboxes: {
      create: (opts) => Sandbox.create(opts, transport),
      attach: (name, opts) => Sandbox.attach(name, opts, transport),
      deploy: (input) => deploySandbox(input, transport),
      createPreview: (input) => createSandboxPreview(input, transport),
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
    orchestrations: {
      run: (spec) => orchestrationsRun(spec, transport),
      launch: (spec) => orchestrationsLaunch(spec, transport),
    },
    fileStorage: {
      upload: (input) => fileStorage.upload(input, transport),
      getDownloadUrl: (fileId) => fileStorage.getDownloadUrl(fileId, transport),
      list: (opts) => fileStorage.list(opts, transport),
      delete: (fileId) => fileStorage.delete(fileId, transport),
      setVisibility: (fileId, visibility) =>
        fileStorage.setVisibility(fileId, visibility, transport),
    },
    contentGeneration: {
      images: {
        create: (input) => contentGeneration.createImage(input, transport),
      },
      video: {
        create: (input) => contentGeneration.createVideo(input, transport),
        launch: (input) => contentGeneration.launchVideo(input, transport),
      },
    },
    search: {
      scrape: (input) => scrape(input, transport),
      webSearch: (input) => webSearch(input, transport),
      emailSearch: {
        findEmail: (input) => findEmail(input, transport),
        verifyEmail: (input) => verifyEmail(input, transport),
        domainSearch: (input) => domainSearch(input, transport),
      },
    },
    memory: {
      append: (input) => memory.append(input, transport),
      recall: (input) => memory.recall(input, transport),
      get: (id) => memory.get(id, transport),
      forget: (id) => memory.forget(id, transport),
    },
    database: {
      create: (input) => database.create(input, transport),
      get: (idOrHandle) => database.get(idOrHandle, transport),
      delete: (idOrHandle) => database.delete(idOrHandle, transport),
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
