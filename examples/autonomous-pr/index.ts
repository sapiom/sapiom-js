import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  resolveResourceHandle,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { CODING_RESULT_SIGNAL, type CodingResultPayload } from "@sapiom/tools";
import { z } from "zod/v4";
import { SEED_PREAMBLE } from "./seed.js";

/**
 * autonomous-pr — point it at a repo; a coding agent picks up a task, writes
 * the code, runs your checks, deploys a live preview of the branch, and
 * pushes it carrying its own self-review.
 *
 * Fuses `dependency-upgrade` (coding agent → sandbox re-attach → real checks →
 * gate the push on green) with `pr-review-bot` (a second model reading a diff
 * to write a structured review), and borrows the demo-database's
 * provision-or-reuse pattern (`nl-db-query-endpoint`) for the repo itself
 * plus `research-to-microsite`'s `deployPreview` for a live look at the
 * branch, into one end-to-end repo-lifecycle agent rather than a narrow bump
 * or a read-only review.
 *
 *   plan ─▶ implement ──(pause: models.coding.result → verify)──▶ verify ─┬─▶ push ─▶ preview ─▶ review ─▶ summary
 *                                                                          └─▶ rejected
 *
 *   - plan       resolves the repo through the SAME injection seam the demo
 *                database uses (`resolveResourceHandle`, key `repoSlug`). A
 *                named repo must already exist. With none named, it opens
 *                (or provisions, the first time) a PERSISTENT demo repo
 *                (`autonomous-pr-demo`) — reused across runs, never
 *                recreated, exactly like `nl-db-query-endpoint`'s demo
 *                database.
 *   - implement  launches a coding agent (`models.coding`) on the repo, then
 *                SUSPENDS at $0 until it finishes — coding runs are long.
 *                Only the run that actually provisions the demo repo (its
 *                first use) also seeds a tiny `AUTHORING.md` and two minimal
 *                examples first, in the SAME agent turn as the task, not a
 *                second billed run; every later run against that same repo
 *                just does the task against what is already there. The
 *                agent only edits files — it is never asked to run git.
 *   - verify     re-attaches that sandbox, confirms the checkout's real
 *                directory, and runs the repo's own install + check commands
 *                over the agent's (still uncommitted) changes. A failed
 *                coding run or a red check routes to `rejected`; nothing is
 *                branched, previewed, or pushed.
 *   - push       creates a fresh branch, adds a tiny static gallery server
 *                (deterministic, not agent-authored) so the branch is
 *                something `deployPreview` can actually serve, and pushes it
 *                all (`repositories.pushFromSandbox`, which commits whatever
 *                is pending and pushes) — the platform's git host has no
 *                hosted pull-request object yet, so the pushed branch is
 *                what you review.
 *   - preview    deploys that branch to a live preview URL
 *                (`sandboxes.deployPreview`, `source: { kind: "git" }`) so a
 *                reviewer can look at the actual result, not just a diff. A
 *                failed deploy degrades honestly (`previewStatus`,
 *                `previewUrl: null`) rather than failing an otherwise green,
 *                already-pushed run.
 *   - review     a second model (`llm.run`) reads the diff and the coding
 *                agent's own notes and writes a short self-review: a verdict,
 *                a summary, and what it would flag.
 *   - summary    returns everything: the repo, the branch, the sha, the
 *                preview URL, and the self-review.
 *   - rejected   no repo, a failed coding run, or a red check — archived only
 *                in the run's own output; nothing is branched or pushed.
 *
 * The push is the one irreversible step, so it only happens after `verify`'s
 * checks are green — same gate `dependency-upgrade` uses for its push.
 */

const DEFAULT_TASK =
  "Read this repo's AUTHORING.md (or nearest CONTRIBUTING/README) and add ONE " +
  "new example directory that follows its conventions exactly — its own " +
  "runnable code plus its manifest. Keep the change small, self-contained, " +
  "and covered by the repo's own checks.";

/**
 * The persistent handle a zero-input run opens (or provisions, once). Naming
 * a plausible-looking handle here would be exactly the mistake AUTHORING.md
 * warns against for a `repoSlug` default; this one is different because this
 * run actually provisions it when it is missing, the same contract
 * `nl-db-query-endpoint`'s `DEFAULT_DB_HANDLE` keeps for its demo database.
 */
const DEFAULT_REPO_HANDLE = "autonomous-pr-demo";

// The demo repo starts out empty THE FIRST TIME it is provisioned, so "add a
// new example following this repo's conventions" is meaningless until
// something establishes those conventions. `SEED_PREAMBLE` (imported above,
// from `./seed.ts`) is handed to the SAME coding-agent run as exact file
// content to write before the real task — a tiny, self-contained slice of a
// real examples repo, not a copy of this one — but only on the run that
// actually provisions it (`justProvisioned`); every later run against that
// same reused repo finds the seed already there and just does the task. It
// lives in its own module because its literal text contains `entry:` /
// `defineAgent` / `defineStep` — tokens a static scan of this file
// (`examples-entry-schema-check`) looks for to find *this* template's own
// entry step; left inline, it would find the seeded example's instead.
// Never applied to a `repoSlug` the caller supplied — a real repo's
// conventions are whatever it already has.

/**
 * A tiny, dependency-free static server, deterministic (not agent-authored)
 * so `preview` always has something real to deploy regardless of what the
 * coding agent did. Written into the checkout in `push`, right before the
 * branch is pushed, so it travels with every push. At request time it reads
 * whatever `template.json` files exist under `examples/<id>/` in the checkout
 * and renders a plain gallery listing — reads live, on every request, so the
 * preview is always the branch's actual current content, never a snapshot
 * baked in ahead of time. An unrelated repo with no `examples/` directory
 * still serves cleanly; it just lists zero examples.
 */
const PREVIEW_SERVER_FILE = "sapiom-preview-server.mjs";
const PREVIEW_PORT = 3000;
const PREVIEW_SANDBOX_TTL = "1h";
// Client-side bound on the preview deploy, kept under this step's own
// `timeoutMs`. A git-source deploy waits for the branch's server to answer, so
// bounding it ourselves guarantees a slow or unresponsive deploy becomes a
// caught error the `catch` below degrades honestly — keeping "the preview is a
// bonus; a failed one never fails an already-pushed run" true for a deploy
// that never comes up, not just one that throws.
const PREVIEW_DEPLOY_TIMEOUT_MS = 240_000;
const PREVIEW_SERVER_SOURCE = `import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const EXAMPLES_DIR = path.join(process.cwd(), "examples");

function listExamples() {
  if (!fs.existsSync(EXAMPLES_DIR)) return [];
  return fs
    .readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter(function (entry) {
      return entry.isDirectory();
    })
    .map(function (entry) {
      var whatItDoes = "";
      try {
        var manifestPath = path.join(EXAMPLES_DIR, entry.name, "template.json");
        var raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (typeof raw.whatItDoes === "string") whatItDoes = raw.whatItDoes;
      } catch (err) {
        // No manifest yet (or it does not parse). List the directory anyway.
      }
      return { id: entry.name, whatItDoes: whatItDoes };
    })
    .sort(function (a, b) {
      return a.id.localeCompare(b.id);
    });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function render(examples) {
  var items = examples
    .map(function (example) {
      var label = "<strong>" + escapeHtml(example.id) + "</strong>";
      var detail = example.whatItDoes
        ? " - " + escapeHtml(example.whatItDoes)
        : "";
      return "<li>" + label + detail + "</li>";
    })
    .join("\\n");
  return (
    "<!doctype html><html><head><meta charset=\\"utf-8\\">" +
    "<title>Examples gallery</title></head><body>" +
    "<h1>Examples gallery</h1>" +
    "<p>" + examples.length + " example(s) in this repo.</p>" +
    "<ul>" + items + "</ul>" +
    "</body></html>"
  );
}

http
  .createServer(function (req, res) {
    var examples = listExamples();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(render(examples));
  })
  .listen(PORT, function () {
    console.log("gallery preview listening on " + PORT);
  });
`;

// ──────────────────────────────────────────────────────────────── input ──
interface AutonomousPrInput {
  /**
   * In-network repo the coding agent works in. Absent ⇒ opens (or provisions,
   * the first time) the persistent demo repo instead — read through
   * `resolveResourceHandle`, the same seam `nl-db-query-endpoint` uses for its
   * demo database.
   */
  repoSlug?: string;
  /** Plain-words task for the coding agent (default: add an example following AUTHORING.md). */
  task?: string;
  /** Command that installs dependencies in the checkout (default `npm install`). */
  installCommand?: string;
  /** Command that must pass before anything is pushed (default `npm run typecheck`). */
  checkCommand?: string;
}

type Mode = "byo" | "demo";

interface Review {
  verdict: "approve" | "comment" | "request_changes";
  summary: string;
  notes: string[];
}

/** Run-scoped state; the values before the pause survive the suspend. */
interface Shared extends Record<string, unknown> {
  mode: Mode;
  /** True only for the run that actually called `repositories.create` — gates the seed. */
  justProvisioned: boolean;
  repoSlug: string;
  cloneUrl: string;
  task: string;
  installCommand: string;
  checkCommand: string;
  branchName: string;
  sandboxName: string | null;
  /** The sandbox dir the checkout was actually verified in (never assumed). */
  checkoutCwd: string | null;
  codingSummary: string | null;
  diffStat: string | null;
  checkTail: string | null;
  pushed: boolean;
  pushSha: string | null;
  pushBranch: string | null;
  previewUrl: string | null;
  previewStatus: string | null;
  previewLogs: string | null;
  review: Review | null;
  /**
   * Why the self-review is absent, when it is. Never a stand-in verdict — the
   * point is that a reader can tell an unanswered review from an approval.
   */
  reviewUnavailable: string | null;
}

type Ctx = AgentExecutionContext<Shared>;

// ──────────────────────────────────────────────────────────────── steps ──

/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. `repoSlug` has no default on
 * purpose — a repository must exist, so an empty value means "provision one",
 * not "guess a plausible one".
 */
const entryInput = z.object({
  repoSlug: z
    .string()
    .optional()
    .describe(
      "In-network repo the coding agent works in. Absent ⇒ opens (or provisions, the first time) the persistent demo repo.",
    ),
  task: z
    .string()
    .default(DEFAULT_TASK)
    .describe("Plain-words task for the coding agent."),
  installCommand: z
    .string()
    .default("npm install")
    .describe("Command that installs dependencies in the checkout."),
  checkCommand: z
    .string()
    .default("npm run typecheck")
    .describe("Command that must pass before anything is pushed."),
});

const plan = defineStep({
  name: "plan",
  inputSchema: entryInput,
  next: ["implement", "rejected"],
  async run(input: AutonomousPrInput, ctx: Ctx) {
    const task = input?.task?.trim() || DEFAULT_TASK;
    const installCommand = input?.installCommand?.trim() || "npm install";
    const checkCommand = input?.checkCommand?.trim() || "npm run typecheck";
    ctx.shared.set("task", task);
    ctx.shared.set("installCommand", installCommand);
    ctx.shared.set("checkCommand", checkCommand);
    ctx.shared.set("branchName", `autonomous-pr/${slugify(ctx.executionId)}`);
    ctx.shared.set("sandboxName", null);
    ctx.shared.set("checkoutCwd", null);
    ctx.shared.set("codingSummary", null);
    ctx.shared.set("diffStat", null);
    ctx.shared.set("checkTail", null);
    ctx.shared.set("pushed", false);
    ctx.shared.set("pushSha", null);
    ctx.shared.set("pushBranch", null);
    ctx.shared.set("previewUrl", null);
    ctx.shared.set("previewStatus", null);
    ctx.shared.set("previewLogs", null);
    ctx.shared.set("review", null);
    ctx.shared.set("reviewUnavailable", null);

    // Read the target handle through the canonical injection seam so a
    // deploy-time reuse picker can repoint this at a repo you already own —
    // same seam, same fallback discipline as `nl-db-query-endpoint`'s
    // `dbHandle`. The fallback is `""`, not `DEFAULT_REPO_HANDLE`: "no handle
    // named" is what selects the persistent demo repo below, and a
    // caller-named handle that 404s is rejected rather than silently
    // reprovisioned under a name they didn't ask for.
    const requestedSlug = resolveResourceHandle(input ?? {}, {
      fallback: "",
      key: "repoSlug",
    });
    const usingDemoRepo = !requestedSlug;
    const targetSlug = usingDemoRepo ? DEFAULT_REPO_HANDLE : requestedSlug;

    try {
      const repo = await ctx.sapiom.repositories.get(targetSlug);
      ctx.shared.set("mode", usingDemoRepo ? "demo" : "byo");
      ctx.shared.set("justProvisioned", false);
      ctx.shared.set("repoSlug", repo.slug);
      ctx.shared.set("cloneUrl", repo.cloneUrl);
      ctx.logger.info("opened an existing repo", {
        repoSlug: repo.slug,
        reused: usingDemoRepo,
      });
      return goto("implement", {});
    } catch (err) {
      if (!usingDemoRepo) {
        // A repository is a RESOURCE: a caller-named one has to exist. There
        // is deliberately no default slug — naming a plausible one (`my-app`)
        // turns a clean rejection into a 404 mid-run, and a handle you did
        // name is never silently reprovisioned under you.
        return goto("rejected", {
          reason: "repo-not-found",
          detail:
            `No in-network repository named \`${requestedSlug}\` was found, ` +
            `so nothing was cloned or changed (${String(err)}).`,
          unmet: ["repoSlug"],
        });
      }
      // A resource-shaped need PROVISIONS rather than rejects — the demo repo
      // just doesn't exist yet (its first use). Every later run finds it via
      // `repositories.get` above and reuses it; nothing here recreates it.
      ctx.logger.info("provisioning the persistent demo repo", {
        repoSlug: targetSlug,
      });
      try {
        const repo = await ctx.sapiom.repositories.create(targetSlug);
        ctx.shared.set("mode", "demo");
        ctx.shared.set("justProvisioned", true);
        ctx.shared.set("repoSlug", repo.slug);
        ctx.shared.set("cloneUrl", repo.cloneUrl);
        return goto("implement", {});
      } catch (createErr) {
        return goto("rejected", {
          reason: "provision-failed",
          detail:
            "Could not provision the persistent demo repository, so there " +
            `was nothing to work in (${String(createErr)}).`,
        });
      }
    }
  },
});

/**
 * Launch the coding agent on the repo and suspend until it finishes. It only
 * edits files — never asked to run git — so the branch and the push stay in
 * `verify` / `push`, exact and repeatable rather than depending on the agent.
 */
const implement = defineStep({
  name: "implement",
  next: [],
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "verify" },
  async run(_input: unknown, ctx: Ctx) {
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const justProvisioned = ctx.shared.get("justProvisioned") === true;
    const task = ctx.shared.get("task") ?? DEFAULT_TASK;
    const repo = await ctx.sapiom.repositories.get(repoSlug);

    // Seed only the run that just provisioned the demo repo — every later
    // run against that same, reused repo finds the seed already there.
    const fullTask = (justProvisioned ? SEED_PREAMBLE : "") + `Task: ${task}`;

    ctx.logger.info("launching coding agent", { repoSlug, justProvisioned });
    const handle = await ctx.sapiom.models.coding.launch({
      task: fullTask,
      gitRepository: repo,
    });
    return await pauseUntilSignal(handle, { resumeStep: "verify" });
  },
});

/**
 * Re-attach the coding run's sandbox and run the repo's own install + check
 * commands over the agent's (still uncommitted) changes. Only a green check
 * reaches `push`.
 */
const verify = defineStep({
  name: "verify",
  next: ["push", "rejected"],
  timeoutMs: 900_000,
  async run(result: CodingResultPayload, ctx: Ctx) {
    const codingSummary = result?.summary ?? null;
    ctx.shared.set("codingSummary", codingSummary);

    // The coding agent itself failed — there's nothing to check.
    if (result?.status === "failed" || result?.error) {
      return goto("rejected", {
        reason: "coding-run-failed",
        detail: result?.error?.message ?? codingSummary ?? "coding run failed",
      });
    }

    const sandboxName = result?.executionEnvironment?.id ?? null;
    ctx.shared.set("sandboxName", sandboxName);
    if (!sandboxName) {
      return goto("rejected", {
        reason: "no-sandbox",
        detail: "the coding run provisioned no sandbox to check in",
      });
    }

    const installCommand = ctx.shared.get("installCommand") ?? "npm install";
    const checkCommand = ctx.shared.get("checkCommand") ?? "npm run typecheck";
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const box = ctx.sapiom.sandboxes.attach(sandboxName);

    // `gitRepository` is DOCUMENTED to clone into the sandbox at
    // `/workspace/<slug>`, but that's the platform's word, not a guarantee
    // this run kept — verify it before trusting it, and if it doesn't hold,
    // locate the checkout instead of silently running every command in the
    // wrong directory.
    const resolved = await resolveCheckoutCwd(box, repoSlug, ctx);
    if (!resolved.cwd) {
      ctx.shared.set("checkTail", resolved.probe);
      return goto("rejected", {
        reason: "checkout-not-found",
        detail:
          `Could not find the coding run's checkout in sandbox \`${sandboxName}\` ` +
          `(expected \`/workspace/${repoSlug}\`): ${resolved.probe}`,
      });
    }
    const cwd = resolved.cwd;
    ctx.shared.set("checkoutCwd", cwd);

    // Capture what changed, for the self-review. The coding agent's edits are
    // almost all NEW files, and a plain `git diff --stat` (working tree vs
    // index) never shows untracked files — so it came back empty and the
    // reviewer withheld approval, citing "conformance asserted, not
    // demonstrated." Stage first (`add -A`, before install so no `node_modules`
    // exists yet) and diff the index (`--cached`), which surfaces new files as
    // additions against HEAD (or the empty tree on a first commit). `git -C
    // <abs>` (not the `cwd` exec option) targets the checkout — see the
    // resolveCheckoutCwd note for why the absolute path is baked in.
    try {
      await box.exec(`git -C "${cwd}" add -A`, { timeout: 30_000 });
      const diff = await box.exec(
        `git -C "${cwd}" --no-pager diff --cached --stat`,
        { timeout: 30_000 },
      );
      ctx.shared.set(
        "diffStat",
        (diff.stdout || diff.stderr || "").slice(0, 4000),
      );
    } catch (err) {
      ctx.shared.set("diffStat", `diff unavailable: ${String(err)}`);
    }

    const install = await box.exec(`cd "${cwd}" && ${installCommand}`, {
      timeout: 300_000,
    });
    if (install.exitCode !== 0) {
      const installTail = tail(install.stdout, install.stderr);
      ctx.shared.set("checkTail", installTail);
      return goto("rejected", {
        reason: "install-failed",
        // The seeded `package.json` pins `@sapiom/agent`/`@sapiom/tools` to
        // ranges confirmed resolvable on the public npm registry — if this
        // is a resolution error rather than a real dependency problem, the
        // sandbox's npm is very likely pointed somewhere else. `installTail`
        // (echoed below) carries npm's own error, so this isn't a guess.
        detail:
          `\`${installCommand}\` exited ${install.exitCode} in \`${cwd}\` ` +
          "(if this is a package-resolution error rather than a real " +
          "dependency problem, check the sandbox's npm registry — the " +
          "seeded deps are pinned to versions published on the public " +
          `npm registry). Install output:\n${installTail}`,
      });
    }

    const check = await box.exec(`cd "${cwd}" && ${checkCommand}`, {
      timeout: 300_000,
    });
    // A passing check (e.g. `tsc --noEmit`) prints nothing, which left the
    // review's "Check output" empty and undersold a green run — record the
    // exit-0 explicitly so the reviewer sees the check actually ran and passed.
    const checkOutput = tail(check.stdout, check.stderr);
    ctx.shared.set(
      "checkTail",
      check.exitCode === 0
        ? `\`${checkCommand}\` passed (exit 0).${checkOutput ? `\n${checkOutput}` : ""}`
        : checkOutput,
    );
    if (check.exitCode !== 0) {
      return goto("rejected", {
        reason: "check-failed",
        detail: `\`${checkCommand}\` exited ${check.exitCode}`,
      });
    }

    ctx.logger.info("check green", { checkCommand });
    return goto("push", {});
  },
});

/**
 * Create a fresh branch ourselves (the agent never ran git), add the
 * deterministic preview server so `preview` has something real to deploy
 * from this branch, and push the agent's changes (plus that one file) to it.
 * `pushFromSandbox` commits whatever is pending and pushes the currently
 * checked-out branch — the reviewable unit, since this git host has no
 * hosted pull-request object yet.
 */
const push = defineStep({
  name: "push",
  next: ["preview"],
  async run(_input: unknown, ctx: Ctx) {
    const sandboxName = ctx.shared.get("sandboxName") ?? "";
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const branchName = ctx.shared.get("branchName") ?? "autonomous-pr/task";
    const task = ctx.shared.get("task") ?? DEFAULT_TASK;
    const box = ctx.sapiom.sandboxes.attach(sandboxName);

    // `verify` already found and confirmed the checkout's real directory —
    // reuse it rather than re-assume `/workspace/<slug>`, so the branch this
    // creates is the SAME checkout `verify` just ran the checks against.
    // `git -C <abs>`, not the `cwd` exec option — see the note in `verify`.
    const cwd = ctx.shared.get("checkoutCwd") ?? `/workspace/${repoSlug}`;
    await box.exec(`git -C "${cwd}" checkout -b ${branchName}`, {
      timeout: 30_000,
    });

    // Deterministic, not agent-authored: written here so `preview` always has
    // something real to serve from this branch, regardless of what the task
    // touched. Written through `exec` with the confirmed ABSOLUTE checkout
    // path — NOT `box.writeFile`, whose paths resolve against the sandbox's
    // `workspaceRoot` (which `sandboxes.attach` roots away from this checkout),
    // so `writeFile("${cwd}/…")` silently lands the file OUTSIDE the tree
    // `pushFromSandbox` commits — the exact inverse of the `exec`-cwd trap
    // `verify` documents. base64-pipe so the source survives shell quoting
    // intact, then stage it explicitly.
    const previewServerB64 = Buffer.from(
      PREVIEW_SERVER_SOURCE,
      "utf8",
    ).toString("base64");
    await box.exec(
      `printf %s '${previewServerB64}' | base64 -d > "${cwd}/${PREVIEW_SERVER_FILE}"`,
      { timeout: 30_000 },
    );
    await box.exec(`git -C "${cwd}" add "${PREVIEW_SERVER_FILE}"`, {
      timeout: 30_000,
    });

    // Keep installed dependencies out of the reviewed branch. `verify` ran the
    // repo's install, so `node_modules/` now exists in the checkout, and
    // `pushFromSandbox` stages pending files wholesale — without this the
    // pushed branch is thousands of dependency files, not the change under
    // review. Ensure `.gitignore` excludes it (idempotent), and drop it from
    // the index if a prior reused run already tracked it. `cd "<abs>"` in the
    // command targets the real checkout, same discipline as `verify`'s install.
    await box.exec(
      `cd "${cwd}" && (grep -qxF 'node_modules/' .gitignore 2>/dev/null || ` +
        `printf 'node_modules/\\npackage-lock.json\\n' >> .gitignore) && ` +
        `git add .gitignore && (git rm -r --cached --quiet node_modules 2>/dev/null || true)`,
      { timeout: 60_000 },
    );

    const repo = await ctx.sapiom.repositories.get(repoSlug);
    const message = truncate(`feat: ${task}`, 72);
    // Pass the confirmed working directory explicitly rather than relying on
    // `pushFromSandbox`'s own `/workspace/<slug>` default — the same
    // directory the branch above was just created in.
    const result = await repo.pushFromSandbox(box, {
      message,
      workingDirectory: cwd,
    });

    // `pushFromSandbox` doesn't always return the commit sha; read it back from
    // the checkout it just committed so `summary` reports a real sha, not null.
    let pushSha = result.sha;
    if (!pushSha) {
      try {
        const rev = await box.exec(`git -C "${cwd}" rev-parse HEAD`, {
          timeout: 15_000,
        });
        pushSha = rev.stdout.trim() || null;
      } catch {
        pushSha = null;
      }
    }
    ctx.shared.set("pushed", result.pushed);
    ctx.shared.set("pushSha", pushSha);
    ctx.shared.set("pushBranch", result.branch ?? branchName);
    ctx.logger.info("pushed branch", {
      branch: result.branch ?? branchName,
      sha: result.sha,
    });
    return goto("preview", {});
  },
});

/**
 * Deploy a live preview of the pushed branch (`sandboxes.deployPreview`,
 * `source: { kind: "git" }` — the server clones the branch itself, no local
 * upload needed) so a reviewer can look at the actual result, not just a
 * diff. Best-effort: a failed or unreachable deploy degrades honestly
 * (`previewStatus`, `previewUrl: null`) rather than failing an otherwise
 * green, already-pushed run — the pushed branch is the artifact that
 * matters; the preview is a bonus look at it.
 */
const preview = defineStep({
  name: "preview",
  next: ["review"],
  timeoutMs: 300_000,
  async run(_input: unknown, ctx: Ctx) {
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const branchName =
      ctx.shared.get("pushBranch") ?? ctx.shared.get("branchName") ?? "main";
    const hostName = `autonomous-pr-preview-${slugify(ctx.executionId)}`;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const host = await ctx.sapiom.sandboxes.create({
        name: hostName,
        port: PREVIEW_PORT,
        ttl: PREVIEW_SANDBOX_TTL,
      });
      // Race the deploy against our own timer (see `PREVIEW_DEPLOY_TIMEOUT_MS`)
      // so a deploy that never binds the port becomes a caught error the
      // `catch` degrades, not a hang that stalls the whole run.
      const deploy = await Promise.race([
        host.deployPreview({
          source: { kind: "git", repo: repoSlug, ref: branchName },
          start: `node ${PREVIEW_SERVER_FILE}`,
          port: PREVIEW_PORT,
          env: { PORT: String(PREVIEW_PORT) },
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "preview deploy did not return within the preview budget",
                ),
              ),
            PREVIEW_DEPLOY_TIMEOUT_MS,
          );
        }),
      ]);
      ctx.shared.set("previewUrl", deploy.url);
      ctx.shared.set("previewStatus", deploy.status);
      ctx.shared.set("previewLogs", tail(deploy.logs, ""));
      if (deploy.status === "failed" || !deploy.url) {
        ctx.logger.warn("preview deploy did not come up", {
          status: deploy.status,
        });
      } else {
        ctx.logger.info("preview deployed", { url: deploy.url });
      }
    } catch (err) {
      // Never fail the run over the preview — the branch is already pushed.
      ctx.shared.set("previewUrl", null);
      ctx.shared.set("previewStatus", "failed");
      ctx.shared.set("previewLogs", String(err));
      ctx.logger.warn("preview deploy did not complete", { err: String(err) });
    } finally {
      // Clear the timer whether the deploy resolved, threw, or timed out — a
      // pending timer would otherwise reject later, unobserved.
      if (timer) clearTimeout(timer);
    }
    return goto("review", {});
  },
});

/**
 * A second model reads the diff and the coding agent's own notes and writes a
 * short self-review — a verdict, a summary, and what it would flag. Purely
 * informational: it never blocks the push, which already happened.
 */
const review = defineStep({
  name: "review",
  next: ["summary"],
  timeoutMs: 60_000,
  async run(_input: unknown, ctx: Ctx) {
    const diffStat = ctx.shared.get("diffStat") ?? "";
    const checkTail = ctx.shared.get("checkTail") ?? "";
    const codingSummary = ctx.shared.get("codingSummary") ?? "";
    const task = ctx.shared.get("task") ?? DEFAULT_TASK;

    const system =
      "You are reviewing your own pull request before a human sees it. The " +
      "checks already passed. Judge whether the change actually does the " +
      "stated task, is scoped tightly to it, and reads like something you'd " +
      "approve.";
    const prompt =
      `Task:\n${task}\n\n` +
      `Coding agent's own summary:\n${codingSummary}\n\n` +
      `Diff (stat):\n${diffStat}\n\n` +
      `Check output (tail):\n${checkTail}`;

    const res = await ctx.sapiom.llm.run({
      request: {
        system,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
      },
      output: { name: REVIEW_TOOL, schema: REVIEW_SCHEMA },
    });

    // The branch is already pushed, so — exactly as with the preview above —
    // this advisory step never fails the run. What it must never do is invent a
    // verdict: an unavailable self-review is reported as `review: null` plus a
    // reason, so a reader can tell "the model didn't answer" from "the model
    // approved it".
    try {
      const rev = readReview(ctx.sapiom.llm.structuredOf(res, REVIEW_TOOL));
      ctx.shared.set("review", rev);
      ctx.shared.set("reviewUnavailable", null);
      ctx.logger.info("self-review complete", { verdict: rev.verdict });
    } catch (err) {
      ctx.shared.set("review", null);
      ctx.shared.set("reviewUnavailable", String(err));
      ctx.logger.warn("self-review unavailable — reporting no verdict", {
        err: String(err),
      });
    }
    return goto("summary", {});
  },
});

/** Green, pushed, and self-reviewed: return everything. */
const summary = defineStep({
  name: "summary",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: Ctx) {
    const mode = ctx.shared.get("mode") ?? "byo";
    return terminate({
      mode,
      repoSlug: ctx.shared.get("repoSlug") ?? "",
      cloneUrl: ctx.shared.get("cloneUrl") ?? "",
      branch:
        ctx.shared.get("pushBranch") ?? ctx.shared.get("branchName") ?? "",
      sha: ctx.shared.get("pushSha") ?? null,
      pushed: ctx.shared.get("pushed") === true,
      // No hosted pull-request object exists yet — never fabricate one.
      prUrl: null,
      previewUrl: ctx.shared.get("previewUrl") ?? null,
      previewStatus: ctx.shared.get("previewStatus") ?? null,
      task: ctx.shared.get("task") ?? DEFAULT_TASK,
      codingSummary: ctx.shared.get("codingSummary") ?? null,
      review: ctx.shared.get("review") ?? null,
      reviewUnavailable: ctx.shared.get("reviewUnavailable") ?? null,
      note:
        (mode === "demo"
          ? "Ran against Sapiom's persistent demo repo for this template " +
            "(reused across runs) — set `repoSlug` to your own in-network " +
            "repo to work on something real. "
          : "") +
        "This git host has no hosted pull-request object yet, so the pushed " +
        "branch above is what you review — there is no `prUrl` to open.",
    });
  },
});

/** No repo, a failed coding run, or a red check: nothing branched, nothing pushed. */
const rejected = defineStep({
  name: "rejected",
  next: [],
  terminal: true,
  async run(
    input: { reason: string; detail?: string; unmet?: string[] },
    ctx: Ctx,
  ) {
    const mode = ctx.shared.get("mode") ?? "byo";
    ctx.logger.info("autonomous PR rejected", { reason: input?.reason });
    return terminate({
      mode,
      repoSlug: ctx.shared.get("repoSlug") ?? "unknown",
      pushed: false,
      reason: input?.reason ?? "unknown",
      detail: input?.detail ?? null,
      checkTail: ctx.shared.get("checkTail") ?? null,
      ...(input?.unmet?.length
        ? { unmet: input.unmet, note: input.detail ?? null }
        : {}),
    });
  },
});

// ────────────────────────────────────────────────────────────── helpers ──

/** Lowercase, hyphenated, bounded — safe inside a repo slug or a branch name. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 16) || "run"
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Resolve the sandbox directory the coding run's checkout actually lives in,
 * instead of trusting that `gitRepository` cloned to exactly
 * `/workspace/<slug>`. That path is `models.coding`'s documented convention,
 * not a contract this run necessarily kept, so it's verified — `test -d
 * "<abs>/.git"` at the candidate — before anything is `exec`'d there. Every
 * probe below bakes the absolute path directly into the command rather than
 * passing `exec`'s `cwd` option: `cwd` is relative to the sandbox's
 * `workspaceRoot`, which `sandboxes.attach` (no coding-run context to infer
 * it from) defaults to `/` — so a bare `{ cwd: "/workspace/<slug>" }` here
 * would NOT reliably land in the checkout the way an absolute path in the
 * command itself does. If the documented path doesn't hold, falls back to
 * locating the checkout by its `.git` directory anywhere in the sandbox, then
 * re-verifies that candidate too. Returns `{ cwd: null, probe }` (never a
 * guess) when nothing can be confirmed, so the caller can route to a clear,
 * diagnosable rejection instead of running commands in the wrong directory.
 */
async function resolveCheckoutCwd(
  box: ReturnType<Ctx["sapiom"]["sandboxes"]["attach"]>,
  repoSlug: string,
  ctx: Ctx,
): Promise<{ cwd: string | null; probe: string }> {
  const probeLines: string[] = [];

  const hasGit = async (cwd: string): Promise<boolean> => {
    try {
      const res = await box.exec(`test -d "${cwd}/.git"`, { timeout: 15_000 });
      return res.exitCode === 0;
    } catch (err) {
      probeLines.push(`checking \`${cwd}\` threw: ${String(err)}`);
      return false;
    }
  };

  const candidate = `/workspace/${repoSlug}`;
  if (await hasGit(candidate)) {
    return { cwd: candidate, probe: `confirmed at \`${candidate}\`` };
  }
  probeLines.push(`\`${candidate}\` has no checkout (no .git)`);

  // Fall back: locate any `.git` directory in the sandbox and prefer one
  // whose parent directory name matches the repo slug. Already an absolute
  // search from `/` — no `cwd` option needed here either.
  try {
    const find = await box.exec(
      "find / -maxdepth 6 -type d -name .git -not -path '*/node_modules/*' 2>/dev/null",
      { timeout: 20_000 },
    );
    const gitDirs = find.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    probeLines.push(
      gitDirs.length
        ? `discovery found ${gitDirs.length} checkout(s): ${gitDirs.join(", ")}`
        : "discovery found no checkouts anywhere in the sandbox",
    );

    const checkoutDirs = gitDirs.map((g) => g.replace(/\/\.git$/, ""));
    const bySlug = checkoutDirs.filter((d) => d.split("/").pop() === repoSlug);
    const winner =
      bySlug.length === 1
        ? bySlug[0]
        : checkoutDirs.length === 1
          ? checkoutDirs[0]
          : null;

    if (winner && (await hasGit(winner))) {
      ctx.logger.info("checkout wasn't at the documented path; located it", {
        repoSlug,
        resolved: winner,
      });
      return { cwd: winner, probe: probeLines.join("; ") };
    }
  } catch (err) {
    probeLines.push(`discovery threw: ${String(err)}`);
  }

  return { cwd: null, probe: probeLines.join("; ") };
}

/** Last `max` chars of the combined stdout/stderr — enough to see a failure. */
function tail(stdout: string, stderr: string, max = 2000): string {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  return combined.length > max ? combined.slice(-max) : combined;
}

/**
 * The forced tool call `review` reads its self-review out of. `llm.run`'s
 * `output` appends this tool to the request and pins `tool_choice` to it, so
 * the review arrives as a typed `tool_use` block — there is no prose to slice
 * and no JSON to hand-parse.
 */
const REVIEW_TOOL = "emit_self_review";

const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "comment", "request_changes"],
      description:
        "Your call on the change: `approve` if you'd merge it, `comment` for minor notes, `request_changes` for real defects.",
    },
    summary: {
      type: "string",
      description: "One-paragraph summary of the self-review.",
    },
    notes: {
      type: "array",
      items: { type: "string" },
      description: "What you would flag, each a short line.",
    },
  },
  required: ["verdict", "summary", "notes"],
  additionalProperties: false,
};

/**
 * Read the forced tool call back into a `Review`.
 *
 * Throws when the model returned no such block, or returned one without a
 * usable verdict or summary. The self-review is informational and never blocks
 * the push — but a *fabricated* verdict is worse than no verdict, because the
 * human reading the run output cannot tell it apart from one the model
 * actually made. An empty `notes` list is a real answer ("nothing to flag");
 * an absent verdict is not.
 */
export function readReview(structured: unknown): Review {
  if (structured === null || typeof structured !== "object") {
    throw new Error(
      "review: the model returned no structured self-review — refusing to invent a verdict.",
    );
  }
  const raw = structured as Partial<Review>;
  if (
    raw.verdict !== "approve" &&
    raw.verdict !== "comment" &&
    raw.verdict !== "request_changes"
  ) {
    throw new Error(
      `review: the model returned no usable verdict (${JSON.stringify(raw.verdict)}) — refusing to invent one.`,
    );
  }
  if (typeof raw.summary !== "string" || raw.summary.trim() === "") {
    throw new Error(
      "review: the model returned no self-review summary — refusing to invent one.",
    );
  }
  return {
    verdict: raw.verdict,
    summary: raw.summary,
    notes: Array.isArray(raw.notes)
      ? raw.notes.filter((n): n is string => typeof n === "string")
      : [],
  };
}

export const agent = defineAgent<AutonomousPrInput, Shared>({
  name: "autonomous-pr",
  entry: "plan",
  steps: { plan, implement, verify, push, preview, review, summary, rejected },
});
