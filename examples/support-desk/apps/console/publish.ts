/**
 * `pnpm run console:publish`: build the Console and publish it to the org-only App Link
 * `<fleetId>-console`. Running it again republishes to the same link.
 *
 * Three REST calls (create or update the link, upload the bundle, publish). The link carries no
 * key: the platform injects its own runtime SAPIOM_API_KEY into every wake, and on an org-only
 * link that key can write as the publisher, which is all the Console needs. The env map is sent
 * empty on purpose: setting `env` replaces the whole map, so a republish also drops the
 * CONSOLE_API_KEY an older version of this script stored.
 *
 * Needs SAPIOM_API_KEY in this shell only to authenticate these calls; it is not stored.
 */
import { readFileSync } from "node:fs";

import { FLEET_ID, consoleSlugFor } from "../../_shared/fleet-id";
import { readLocalFleetFile, resolveFleetTitle } from "../../scripts/fleet-id";
import { buildConsole } from "./build";

/** The slug keeps the fleet id, so a rename keeps the link and its URL; only the name changes. */
const SLUG = consoleSlugFor(FLEET_ID);
const NAME = resolveFleetTitle(readLocalFleetFile());
const PORT = 3000;
const API = (process.env.SAPIOM_API_URL ?? "https://api.sapiom.ai").replace(
  /\/+$/,
  "",
);
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
      "Run the support desk: tickets with Approve, Escalate, Dismiss, Take and Close, accounts, knowledge, settings and the fleet's health.",
    // No key rides along: the platform's injected runtime key is the Console's credential.
    env: {},
  });
  // The runtime key writes as the publisher; the link must never be reachable outside the org.
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
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
