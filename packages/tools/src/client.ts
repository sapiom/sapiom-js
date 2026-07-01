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
import type { SandboxCreateOptions, SandboxInfo } from "./sandboxes/index.js";
import { Repository } from "./repositories/index.js";
import {
  codingRun,
  codingLaunch,
  run as agentRun,
  launch as agentLaunch,
} from "./agent/index.js";
import type {
  CodingRunSpec,
  CodingRunResult,
  RunHandle,
  AgentRunSpec,
  AgentRunResult,
  AgentRunHandle,
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
import * as database from "./database/index.js";
import type { CreateDatabaseInput, Database } from "./database/index.js";
import * as email from "./email/index.js";
import type {
  CreateInboxInput,
  Inbox,
  ListInboxesOptions,
  InboxList,
  SendMessageInput,
  SendResult,
  ListMessagesOptions,
  MessageList,
  Message,
  ReplyInput,
  ReplyAllInput,
  ListThreadsOptions,
  ThreadList,
  Thread,
  CreateDomainInput,
  Domain,
  DomainList,
  CreateWebhookInput,
  Webhook,
} from "./email/index.js";
import * as domains from "./domains/index.js";
import type {
  CheckInput,
  DomainAvailability,
  DomainNameInput,
  Domain as OwnedDomain,
  DomainTransfer,
  CreateDnsRecordInput,
  UpdateDnsRecordInput,
  DnsRecordRef,
  DnsRecord,
} from "./domains/index.js";

export interface Sapiom {
  readonly sandboxes: {
    create(opts: SandboxCreateOptions): Promise<Sandbox>;
    attach(
      name: string,
      opts?: { workspaceRoot?: string; baseUrl?: string },
    ): Sandbox;
    /** Fetch a sandbox's metadata + status by name (read-only; `attach` to operate). */
    get(name: string, opts?: { baseUrl?: string }): Promise<SandboxInfo>;
    /** List the caller's sandboxes as read-only metadata. */
    list(opts?: { baseUrl?: string }): Promise<SandboxInfo[]>;
  };
  readonly repositories: {
    create(slug: string): Promise<Repository>;
    get(slug: string): Promise<Repository>;
    list(): Promise<Repository[]>;
    delete(slug: string): Promise<void>;
    attach(slug: string, cloneUrl: string): Repository;
  };
  readonly agent: {
    /** Instant in-server agent: prompt (+ optional remote MCP tools) → text. No sandbox. */
    run(spec: AgentRunSpec): Promise<AgentRunResult>;
    /** Launch an instant run; pass the handle to `pauseUntilSignal` to suspend on it. */
    launch(spec: AgentRunSpec): Promise<AgentRunHandle>;
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
   * Programmatic transactional email — inboxes, messages, sending domains,
   * threads, and inbound-event webhooks. An `inboxId` is the inbox's email address.
   */
  readonly email: {
    /** Create / list / get / delete mailboxes. */
    inboxes: {
      /** Create a new inbox (a real, addressable mailbox). */
      create(input?: CreateInboxInput): Promise<Inbox>;
      /** List the caller's inboxes. */
      list(opts?: ListInboxesOptions): Promise<InboxList>;
      /** Fetch a single inbox by id (its email address). */
      get(inboxId: string): Promise<Inbox>;
      /** Delete an inbox by id. */
      delete(inboxId: string): Promise<void>;
    };
    /** Send / list / get / reply / forward messages. */
    messages: {
      /** Send a new message from an inbox. */
      send(inboxId: string, input: SendMessageInput): Promise<SendResult>;
      /** List messages in an inbox (metadata only — use `get` for the body). */
      list(inboxId: string, opts?: ListMessagesOptions): Promise<MessageList>;
      /** Fetch a single full message (including body). */
      get(inboxId: string, messageId: string): Promise<Message>;
      /** Reply to a message. */
      reply(
        inboxId: string,
        messageId: string,
        input?: ReplyInput,
      ): Promise<SendResult>;
      /** Reply to everyone on a message. */
      replyAll(
        inboxId: string,
        messageId: string,
        input?: ReplyAllInput,
      ): Promise<SendResult>;
      /** Forward a message to new recipient(s). */
      forward(
        inboxId: string,
        messageId: string,
        input: SendMessageInput,
      ): Promise<SendResult>;
    };
    /** Register / verify / read custom sending domains. */
    domains: {
      /** Register a custom sending domain. Returns the DNS records to publish. */
      create(input: CreateDomainInput): Promise<Domain>;
      /** Trigger DNS re-verification; re-fetch with `get` to read the updated status. */
      verify(domainId: string): Promise<void>;
      /** Fetch a domain's full status and DNS records by id. */
      get(domainId: string): Promise<Domain>;
      /** List registered domains (without per-domain status/records). */
      list(): Promise<DomainList>;
      /** Delete a registered domain by id. */
      delete(domainId: string): Promise<void>;
    };
    /** List / get conversation threads. */
    threads: {
      /** List conversation threads in an inbox (without their messages). */
      list(inboxId: string, opts?: ListThreadsOptions): Promise<ThreadList>;
      /** Fetch a single full thread (including its messages). */
      get(inboxId: string, threadId: string): Promise<Thread>;
    };
    /** Register / delete inbound-event webhooks. */
    webhooks: {
      /** Register a webhook for inbound events. The returned `secret` is shown only once. */
      create(input: CreateWebhookInput): Promise<Webhook>;
      /** Delete a webhook by id. */
      delete(id: number): Promise<void>;
    };
  };
  /**
   * Register domain names and manage their DNS. `register` and `renew` charge on
   * success; everything else is free. The nested `dns` group manages DNS records
   * on a domain you own.
   */
  readonly domains: {
    /** Check availability + pricing for up to 50 names (free). */
    check(input: CheckInput): Promise<DomainAvailability[]>;
    /** Register (buy) a domain for one year. Charges apply on success. */
    register(input: DomainNameInput): Promise<OwnedDomain>;
    /** Renew a domain you own for one more year. Charges apply on success. */
    renew(input: DomainNameInput): Promise<OwnedDomain>;
    /** List the domains you own. */
    list(): Promise<OwnedDomain[]>;
    /** Get full details for a domain you own. */
    get(input: DomainNameInput): Promise<OwnedDomain>;
    /** Start transferring a domain out; returns an auth code for the new registrar. */
    transferOut(input: DomainNameInput): Promise<DomainTransfer>;
    /** Create / list / get / update / delete DNS records on a domain you own. */
    dns: {
      /** Create a DNS record. */
      create(input: CreateDnsRecordInput): Promise<DnsRecord>;
      /** List a domain's DNS records. */
      list(input: DomainNameInput): Promise<DnsRecord[]>;
      /** Get a single DNS record. */
      get(input: DnsRecordRef): Promise<DnsRecord>;
      /** Update a DNS record (partial — send only the fields to change). */
      update(input: UpdateDnsRecordInput): Promise<DnsRecord>;
      /** Delete a DNS record. */
      delete(input: DnsRecordRef): Promise<void>;
    };
  };
  /**
   * Derive a client that attributes its calls to a different agent/trace. For the
   * router case (one process acting for many agents); step-authoring code doesn't
   * need this — attribution is set once when the client is constructed.
   */
  withAttribution(attribution: Attribution): Sapiom;
}

/** Bind every capability namespace to a transport. `withAttribution` rebinds to a derived one. */
function bind(transport: Transport): Sapiom {
  return {
    sandboxes: {
      create: (opts) => Sandbox.create(opts, transport),
      attach: (name, opts) => Sandbox.attach(name, opts, transport),
      get: (name, opts) => Sandbox.get(name, opts, transport),
      list: (opts) => Sandbox.list(opts, transport),
    },
    repositories: {
      create: (slug) => Repository.create(slug, transport),
      get: (slug) => Repository.get(slug, transport),
      list: () => Repository.list(transport),
      delete: (slug) => Repository.delete(slug, transport),
      attach: (slug, cloneUrl) => Repository.attach(slug, cloneUrl, transport),
    },
    agent: {
      run: (spec) => agentRun(spec, transport),
      launch: (spec) => agentLaunch(spec, transport),
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
    database: {
      create: (input) => database.create(input, transport),
      get: (idOrHandle) => database.get(idOrHandle, transport),
      delete: (idOrHandle) => database.delete(idOrHandle, transport),
    },
    email: {
      inboxes: {
        create: (input) => email.createInbox(input, transport),
        list: (opts) => email.listInboxes(opts, transport),
        get: (inboxId) => email.getInbox(inboxId, transport),
        delete: (inboxId) => email.deleteInbox(inboxId, transport),
      },
      messages: {
        send: (inboxId, input) => email.sendMessage(inboxId, input, transport),
        list: (inboxId, opts) => email.listMessages(inboxId, opts, transport),
        get: (inboxId, messageId) =>
          email.getMessage(inboxId, messageId, transport),
        reply: (inboxId, messageId, input) =>
          email.replyMessage(inboxId, messageId, input, transport),
        replyAll: (inboxId, messageId, input) =>
          email.replyAllMessage(inboxId, messageId, input, transport),
        forward: (inboxId, messageId, input) =>
          email.forwardMessage(inboxId, messageId, input, transport),
      },
      domains: {
        create: (input) => email.createDomain(input, transport),
        verify: (domainId) => email.verifyDomain(domainId, transport),
        get: (domainId) => email.getDomain(domainId, transport),
        list: () => email.listDomains(transport),
        delete: (domainId) => email.deleteDomain(domainId, transport),
      },
      threads: {
        list: (inboxId, opts) => email.listThreads(inboxId, opts, transport),
        get: (inboxId, threadId) =>
          email.getThread(inboxId, threadId, transport),
      },
      webhooks: {
        create: (input) => email.createWebhook(input, transport),
        delete: (id) => email.deleteWebhook(id, transport),
      },
    },
    domains: {
      check: (input) => domains.check(input, transport),
      register: (input) => domains.register(input, transport),
      renew: (input) => domains.renew(input, transport),
      list: () => domains.list(transport),
      get: (input) => domains.get(input, transport),
      transferOut: (input) => domains.transferOut(input, transport),
      dns: {
        create: (input) => domains.createDnsRecord(input, transport),
        list: (input) => domains.listDnsRecords(input, transport),
        get: (input) => domains.getDnsRecord(input, transport),
        update: (input) => domains.updateDnsRecord(input, transport),
        delete: (input) => domains.deleteDnsRecord(input, transport),
      },
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
