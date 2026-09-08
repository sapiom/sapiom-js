import type { HarnessIdentity } from "./auth.js";
import { AGENT_STUDIO_PRODUCT_NAME } from "../shared/branding.js";
import type { CliOptions } from "./args.js";

export function cliBrowserUrl(
  port: number,
  uiToken: string,
  mapLayout?: CliOptions["mapLayout"],
): string {
  const url = new URL(`http://localhost:${port}/`);
  url.searchParams.set("uiToken", uiToken);
  if (mapLayout) url.searchParams.set("mapLayout", mapLayout);
  return url.href;
}

export interface PrintBannerOptions {
  dir: string;
  port: number;
  uiToken: string;
  identity: Pick<
    HarnessIdentity,
    "organizationName" | "userId" | "source"
  > | null;
  telemetryOptIn: boolean;
  serverStarted: boolean;
  mapLayout?: CliOptions["mapLayout"];
}

/** Print the real CLI host banner after the Studio server boot attempt. */
export function printBanner(opts: PrintBannerOptions): void {
  const authLine = opts.identity
    ? `${opts.identity.organizationName} (${opts.identity.userId})${
        opts.identity.source === "cached" ? " — cached" : ""
      }`
    : "not authenticated";

  console.log("");
  console.log(`  ${AGENT_STUDIO_PRODUCT_NAME}`);
  console.log("  ------------");
  console.log(`  directory   ${opts.dir}`);
  console.log(`  auth        ${authLine}`);
  console.log(`  telemetry   ${opts.telemetryOptIn ? "on" : "off"}`);
  // Always the full UI-authorized URL — with --no-open (or a browser that failed
  // to launch) this is the only way to reach the app; a bare host:port
  // cannot receive the privileged browser bootstrap.
  console.log(
    `  url         ${
      opts.serverStarted
        ? cliBrowserUrl(opts.port, opts.uiToken, opts.mapLayout)
        : "(server not started)"
    }`,
  );
  console.log("");
}
