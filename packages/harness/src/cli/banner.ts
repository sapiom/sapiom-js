import type { HarnessIdentity } from "./auth.js";
import { AGENT_STUDIO_PRODUCT_NAME } from "../shared/branding.js";

export interface PrintBannerOptions {
  dir: string;
  port: number;
  bootToken: string;
  identity: Pick<
    HarnessIdentity,
    "organizationName" | "userId" | "source"
  > | null;
  telemetryOptIn: boolean;
  serverStarted: boolean;
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
  // Always the full tokened URL — with --no-open (or a browser that failed
  // to launch) this is the only way to reach the app; a bare host:port
  // 401s on every /api call and can't open the WS connections.
  console.log(
    `  url         ${
      opts.serverStarted
        ? `http://localhost:${opts.port}/?token=${opts.bootToken}`
        : "(server not started)"
    }`,
  );
  console.log("");
}
