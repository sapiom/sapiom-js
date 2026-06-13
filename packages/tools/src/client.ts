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
 * (`import { sandbox } from "@sapiom/tools"`).
 */
import { Transport, type TransportConfig } from "./_client/index.js";
import { Sandbox } from "./sandboxes/index.js";
import type { SandboxCreateOptions } from "./sandboxes/index.js";
import { Repository } from "./repositories/index.js";
import { run as codingRun, launch as codingLaunch } from "./agent/index.js";
import type { CodingRunSpec, CodingRunResult, RunHandle } from "./agent/index.js";

export interface Sapiom {
  readonly sandboxes: {
    create(opts: SandboxCreateOptions): Promise<Sandbox>;
    attach(name: string, opts?: { workspaceRoot?: string; baseUrl?: string }): Sandbox;
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
  // domains, scrape, search, … land here as they're ported.
}

export function createClient(config?: TransportConfig): Sapiom {
  const transport = new Transport(config);
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
  };
}
