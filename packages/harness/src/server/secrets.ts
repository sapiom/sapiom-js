/**
 * Secrets router — backs the right pane's Secrets tab.
 *
 * Two stores, one list. A credential the user typed before their agent existed
 * in the cloud lives locally (core/pending-secrets.ts); one that has reached
 * Sapiom lives in the vault and is listable by NAME only
 * (core/vault-secrets.ts). This router folds them into a single view whose rows
 * carry which of the two they are, because "have I actually shipped this key"
 * is the question the tab exists to answer.
 *
 * NO VALUE LEAVES THIS PROCESS. The API key is held server-side (the same
 * reason account.ts and templates.ts read on the page's behalf), and the only
 * secret material in any response is absent: `GET` returns names and states.
 * A value travels in exactly one direction, browser → here → vault.
 *
 * WHY THE ID IS A PATH. Every other workflow-scoped route addresses an agent by
 * its absolute project directory (`/api/workflows/:id/deploy`), because that is
 * what the SPA holds and what the local store is keyed by. The cloud definition
 * id is read from the project's `sapiom.json` at request time rather than taken
 * from the caller — a client-supplied definition id would let one agent's tab
 * write into another agent's namespace.
 */

import { Router } from "express";
import { readConfig as coreReadConfig } from "@sapiom/agent-core";

import {
  type ApiKeyProvider,
  staticApiKeyProvider,
} from "../core/api-key-provider.js";
import type { PendingSecretsStore } from "../core/pending-secrets.js";
import { flushPendingSecrets } from "../core/secrets-flush.js";
import {
  VaultSecretError,
  createVaultSecretsClient,
  type VaultSecretsClient,
} from "../core/vault-secrets.js";
import type { AgentSecretsView } from "../shared/types.js";

export interface SecretsRouterOpts {
  /** The Sapiom API key (`sk_…`), NOT the local boot token. A provider lets a
   *  rejected key refresh + retry instead of locking the tab. */
  apiKey: string | null | ApiKeyProvider;
  /** Values authored before the agent was linked. */
  pendingSecrets: PendingSecretsStore;
  /** Resolve a registered agent's project directory from the route id. Mirrors
   *  the actions router's seam so this router never reads the registry. */
  resolveWorkflow: (id: string) => { path: string } | null;
  /** Override the core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Injectable fetch. Test seam. */
  fetchImpl?: typeof fetch;
  /** Injectable vault client. Test seam; defaults to the real one. */
  vault?: VaultSecretsClient;
  /** Injectable `sapiom.json` read. Test seam. */
  readConfig?: typeof coreReadConfig;
}

export function createSecretsRouter(opts: SecretsRouterOpts): Router {
  const router = Router();
  const provider: ApiKeyProvider =
    opts.apiKey !== null && typeof opts.apiKey === "object"
      ? opts.apiKey
      : staticApiKeyProvider(opts.apiKey);
  const vault =
    opts.vault ??
    createVaultSecretsClient({
      apiKey: provider,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
    });
  const readConfig = opts.readConfig ?? coreReadConfig;
  const pending = opts.pendingSecrets;

  /**
   * The agent this request is about: its directory, and the cloud definition it
   * is linked to if any. An unparseable `sapiom.json` reads as unlinked rather
   * than as an error — the local half of the tab still works, and refusing the
   * whole surface over a malformed config would take away the one place the
   * user can still make progress.
   */
  const resolve = (
    id: string,
  ): { path: string; definitionId: string | null } | null => {
    const workflow = opts.resolveWorkflow(id);
    if (!workflow) return null;
    try {
      const config = readConfig(workflow.path);
      return {
        path: workflow.path,
        definitionId: config?.definitionId ? String(config.definitionId) : null,
      };
    } catch {
      return { path: workflow.path, definitionId: null };
    }
  };

  /** 404s and answers false when the id names no registered agent. */
  const resolveOr404 = (
    req: { params: Record<string, string | undefined> },
    res: { status: (code: number) => { json: (body: unknown) => void } },
  ): { path: string; definitionId: string | null } | null => {
    const id = req.params.id;
    if (!id || id.trim() === "") {
      res.status(400).json({ error: "agent id is required" });
      return null;
    }
    const agent = resolve(id);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return null;
    }
    return agent;
  };

  /**
   * GET /api/workflows/:id/secrets
   *
   * 200 always for a known agent — an `AgentSecretsView`. Being signed out or
   * unlinked is a state the tab renders, not a failed request.
   */
  router.get("/api/workflows/:id/secrets", async (req, res) => {
    const agent = resolveOr404(req, res);
    if (!agent) return;

    const localNames = pending.names(agent.path);
    const vaultNames = agent.definitionId
      ? await vault.list(agent.definitionId)
      : [];

    // null means the read FAILED, which is not the same as an agent with no
    // secrets. Saying "none" when we simply could not look would invite the
    // user to re-add a credential that is already there.
    const unreadable = vaultNames === null;
    const synced = new Set(vaultNames ?? []);
    const names = [...new Set([...localNames, ...synced])].sort();

    const view: AgentSecretsView = {
      linked: agent.definitionId !== null,
      unreadable,
      secrets: names.map((name) => ({
        name,
        state: synced.has(name) ? "synced" : "pending",
        hasLocalCopy: localNames.includes(name),
      })),
    };
    res.json(view);
  });

  /**
   * POST /api/workflows/:id/secrets  { key, secret }
   *
   * Writes straight to the vault when the agent is linked, and to the local
   * store when it is not — so setting a credential never waits on a deploy.
   *
   * 200  `{ state }` — where the value landed.
   * 400  key/secret missing or empty
   * 502  the vault refused the write (message names the key)
   */
  router.post("/api/workflows/:id/secrets", async (req, res) => {
    const agent = resolveOr404(req, res);
    if (!agent) return;

    const body = req.body as { key?: unknown; secret?: unknown } | null;
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    const secret = typeof body?.secret === "string" ? body.secret : "";
    if (key === "" || secret === "") {
      res.status(400).json({ error: "key and secret are required" });
      return;
    }

    if (!agent.definitionId) {
      await pending.set(agent.path, key, secret);
      res.json({ state: "pending" });
      return;
    }

    try {
      await vault.set(agent.definitionId, key, secret);
      // Keep a local copy so run-local sees the same environment the deployed
      // agent will. Best-effort: the value IS in the vault, which is what the
      // user asked for, so a local write failure must not report the write as
      // failed.
      await pending.set(agent.path, key, secret).catch(() => {});
      res.json({ state: "synced" });
    } catch (err) {
      res.status(502).json({
        error:
          err instanceof VaultSecretError ? err.message : `${key} could not be stored.`,
      });
    }
  });

  /**
   * POST /api/workflows/:id/secrets/import  { entries: [{ key, secret }] }
   *
   * Bulk write for the .env dialog. The upstream route takes ONE key per
   * request, so this is N writes and can partly succeed — the response reports
   * every key individually. An import that lands four of six and says
   * "imported" is the failure the dialog's parse preview exists to prevent, and
   * it must not be reintroduced on the write side.
   *
   * 200  `{ uploaded, failed }`, even when every key failed — the request
   *      itself succeeded and the per-key outcomes are the answer.
   */
  router.post("/api/workflows/:id/secrets/import", async (req, res) => {
    const agent = resolveOr404(req, res);
    if (!agent) return;

    const raw = (req.body as { entries?: unknown } | null)?.entries;
    if (!Array.isArray(raw)) {
      res.status(400).json({ error: "entries[] is required" });
      return;
    }
    const entries = raw.flatMap((entry) => {
      const key = typeof (entry as { key?: unknown })?.key === "string" ? (entry as { key: string }).key.trim() : "";
      const secret =
        typeof (entry as { secret?: unknown })?.secret === "string" ? (entry as { secret: string }).secret : "";
      return key && secret ? [{ key, secret }] : [];
    });

    const uploaded: string[] = [];
    const failed: { key: string; error: string }[] = [];
    for (const entry of entries) {
      try {
        if (agent.definitionId) await vault.set(agent.definitionId, entry.key, entry.secret);
        await pending.set(agent.path, entry.key, entry.secret);
        uploaded.push(entry.key);
      } catch (err) {
        failed.push({
          key: entry.key,
          error:
            err instanceof VaultSecretError
              ? err.message
              : `${entry.key} could not be stored.`,
        });
      }
    }
    res.json({ uploaded, failed, state: agent.definitionId ? "synced" : "pending" });
  });

  /**
   * POST /api/workflows/:id/secrets/flush
   *
   * Uploads every locally-held value to the vault. The tab's answer for an
   * agent deployed from the terminal, where the server never saw a deploy.
   *
   * 200  `SecretFlushResult` (per-key outcomes)
   * 409  the agent is not linked, so there is nothing to upload to
   */
  router.post("/api/workflows/:id/secrets/flush", async (req, res) => {
    const agent = resolveOr404(req, res);
    if (!agent) return;
    if (!agent.definitionId) {
      res.status(409).json({
        error:
          "This agent is not linked to Sapiom yet, so there is nowhere to upload to. Deploy it first.",
      });
      return;
    }
    res.json(
      await flushPendingSecrets({
        pending,
        vault,
        projectPath: agent.path,
        definitionId: agent.definitionId,
      }),
    );
  });

  /**
   * DELETE /api/workflows/:id/secrets/:key       — forget it everywhere
   * DELETE /api/workflows/:id/secrets/:key?local — drop only the local copy
   *
   * 204  removed
   * 502  the vault refused the delete
   */
  router.delete("/api/workflows/:id/secrets/:key", async (req, res) => {
    const agent = resolveOr404(req, res);
    if (!agent) return;
    const key = req.params.key;
    if (!key) {
      res.status(400).json({ error: "key is required" });
      return;
    }

    // `?local` removes the plaintext this machine holds and leaves the deployed
    // credential alone — two genuinely different intents that would otherwise
    // need the user to guess which one delete meant.
    const localOnly = req.query.local !== undefined;
    if (!localOnly && agent.definitionId) {
      try {
        await vault.remove(agent.definitionId, key);
      } catch (err) {
        res.status(502).json({
          error:
            err instanceof VaultSecretError
              ? err.message
              : `${key} could not be removed.`,
        });
        return;
      }
    }
    await pending.remove(agent.path, key);
    res.status(204).end();
  });

  return router;
}
