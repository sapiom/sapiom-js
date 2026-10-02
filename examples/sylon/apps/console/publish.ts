/**
 * `pnpm run console:publish`: build the Console and publish it to the org-only App Link
 * `sylon-console`. Running it again republishes to the same link.
 *
 * Three REST calls (create or update the link with its env map, upload the bundle, publish). The
 * env map carries SAPIOM_API_KEY, taken from this shell and never printed, and CONSOLE_SECRET,
 * which every mutating route requires. The secret is generated once into
 * `.sapiom/console-secret` (gitignored) and reused, because setting `env` replaces the whole map
 * and a republish must not lock out a page that already holds it. Type it into the page once.
 *
 * Needs SAPIOM_API_KEY (an org key for the target org).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildConsole } from "./build";

const SLUG = "sylon-console";
const NAME = "Sylon Console";
const PORT = 3000;
const API = (process.env.SAPIOM_API_URL ?? "https://api.sapiom.ai").replace(
  /\/+$/,
  "",
);
const SECRET_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.sapiom/console-secret",
);

function consoleSecret(): string {
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, "utf8").trim();
  const secret = randomBytes(24).toString("base64url");
  mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  writeFileSync(SECRET_FILE, `${secret}\n`, { mode: 0o600 });
  return secret;
}

interface AppLink {
  id: string;
  url: string;
  visibility: string;
  bundleSha256: string | null;
  bundleManifest: { envKeys?: string[] } | null;
}

async function call<T>(
  key: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      "x-api-key": key,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `${method} ${route} failed (${res.status}): ${text.slice(0, 300)}`,
    );
  return (text ? JSON.parse(text) : {}) as T;
}

async function main() {
  const key = process.env.SAPIOM_API_KEY;
  if (!key)
    throw new Error("set SAPIOM_API_KEY to an org key for the target org");
  const out = await buildConsole();
  const code = readFileSync(out, "utf8");

  const link = await call<AppLink>(key, "POST", "/v1/app-links", {
    slug: SLUG,
    name: NAME,
    description:
      "Operate the Sylon demo: fleet switches, controller, board, latency timeline, failed events, cue cards.",
    env: { SAPIOM_API_KEY: key, CONSOLE_SECRET: consoleSecret() },
  });
  // The server holds an org key; it must never be reachable by anyone outside the org.
  if (link.visibility !== "organization")
    throw new Error(
      `app link ${SLUG} is '${link.visibility}', not organization-only; refusing to publish`,
    );
  await call(key, "PUT", `/v1/app-links/${link.id}/bundle`, {
    files: { "server.mjs": code },
    start: "node server.mjs",
    port: PORT,
  });
  const published = await call<AppLink>(
    key,
    "POST",
    `/v1/app-links/${link.id}/publish`,
  );
  console.log(`published ${published.url}`);
  console.log(`app link ${published.id}, visibility ${published.visibility}`);
  console.log(
    `bundle ${published.bundleSha256} (${(code.length / 1024).toFixed(0)} KiB), env keys: ${published.bundleManifest?.envKeys?.join(", ") ?? "?"}`,
  );
  console.log(
    `console secret: ${path.relative(process.cwd(), SECRET_FILE)} (type it into the page once)`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
