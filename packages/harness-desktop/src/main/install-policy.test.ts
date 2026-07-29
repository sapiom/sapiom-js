/**
 * When may the app install the `sapiom` CLI for the user? Pure, because the
 * wrong answer is either a broken flow (never install) or a network call on
 * every launch and a hijacked `sapiom` for developers (always install).
 */
import { describe, expect, it } from "vitest";

import { SAPIOM_CLI_PACKAGE, shouldInstallSapiomCli } from "./install-policy.js";

describe("shouldInstallSapiomCli", () => {
  it("installs when the CLI is nowhere on PATH", () => {
    expect(shouldInstallSapiomCli({ onPath: null, smoke: false, devMode: false })).toEqual({
      install: true,
      reason: "sapiom is not on PATH",
    });
  });

  it("does nothing when the CLI is already resolvable — never shadow a user's own install", () => {
    // A developer with a global or workspace-linked `sapiom` must keep theirs;
    // the app's prefix is on PATH too, so this is also what makes the install
    // one-shot instead of once-per-launch.
    const outcome = shouldInstallSapiomCli({ onPath: "/usr/local/bin/sapiom", smoke: false, devMode: false });
    expect(outcome.install).toBe(false);
    expect(outcome.reason).toContain("/usr/local/bin/sapiom");
  });

  it("never installs during --smoke — CI must not depend on the network", () => {
    const outcome = shouldInstallSapiomCli({ onPath: null, smoke: true, devMode: false });
    expect(outcome.install).toBe(false);
    expect(outcome.reason).toMatch(/smoke/i);
  });

  it("does not install in dev either — a dev tree has its own workspace copy", () => {
    const outcome = shouldInstallSapiomCli({ onPath: null, smoke: false, devMode: true });
    expect(outcome.install).toBe(false);
    expect(outcome.reason).toMatch(/dev/i);
  });

  it("pins nothing surprising: the spec is the published package", () => {
    // `@latest` is deliberate — see install-policy.ts.
    expect(SAPIOM_CLI_PACKAGE).toBe("@sapiom/cli@latest");
  });
});
