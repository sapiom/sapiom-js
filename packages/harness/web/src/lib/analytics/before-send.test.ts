import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";

import { beforeSend, sanitizeHost, sanitizeUrl } from "./before-send";

function capture(event: string, properties: Record<string, unknown>, extra?: Partial<CaptureResult>): CaptureResult {
  return { event, properties, ...extra } as CaptureResult;
}

describe("sanitizeUrl", () => {
  it("strips the query string (which carries the boot token) and the fragment", () => {
    expect(sanitizeUrl("http://localhost:4100/?token=super-secret")).toBe("http://localhost/");
    expect(sanitizeUrl("http://localhost:4100/workbench?token=x#frag")).toBe("http://localhost/workbench");
  });

  it("collapses the ephemeral port so every boot reports one origin", () => {
    // The harness binds a random free port per boot. Without this, URL
    // breakdowns return one row per session and heatmaps never accumulate.
    expect(sanitizeUrl("http://127.0.0.1:57070/")).toBe("http://localhost/");
    expect(sanitizeUrl("http://127.0.0.1:53213/")).toBe("http://localhost/");
    expect(sanitizeUrl("http://localhost:64964/")).toBe("http://localhost/");
  });

  it("leaves non-loopback origins alone", () => {
    expect(sanitizeUrl("https://app.sapiom.ai:8443/x?y=1")).toBe("https://app.sapiom.ai:8443/x");
  });

  it("passes non-URL / empty values through unchanged", () => {
    expect(sanitizeUrl("not a url")).toBe("not a url");
    expect(sanitizeUrl("")).toBe("");
    expect(sanitizeUrl(undefined)).toBe(undefined);
  });
});

describe("sanitizeHost", () => {
  it("collapses loopback host:port pairs", () => {
    expect(sanitizeHost("127.0.0.1:57070")).toBe("localhost");
    expect(sanitizeHost("localhost:4100")).toBe("localhost");
  });

  it("leaves a real host and non-strings alone", () => {
    expect(sanitizeHost("app.sapiom.ai")).toBe("app.sapiom.ai");
    expect(sanitizeHost(undefined)).toBe(undefined);
  });
});

describe("beforeSend", () => {
  it("returns null/passthrough unchanged for a null result", () => {
    expect(beforeSend(null)).toBeNull();
  });

  it("redacts the boot token from $current_url and person-property URLs", () => {
    const result = capture(
      "$pageview",
      { $current_url: "http://localhost:4100/?token=secret" },
      { $set_once: { $initial_current_url: "http://localhost:4100/?token=secret" } },
    );
    const out = beforeSend(result)!;
    expect((out.properties as Record<string, unknown>).$current_url).toBe("http://localhost/");
    expect((out.$set_once as Record<string, unknown>).$initial_current_url).toBe("http://localhost/");
  });

  it("truncates long click text on a normal surface but keeps it", () => {
    const long = "x".repeat(300);
    const out = beforeSend(capture("$autocapture", { $el_text: long, surface: "agent_rail" }))!;
    const text = (out.properties as Record<string, unknown>).$el_text as string;
    expect(text.length).toBeLessThan(300);
    expect(text.endsWith("…")).toBe(true);
  });

  it("DROPS click text entirely on a secrets surface", () => {
    const out = beforeSend(
      capture("$autocapture", { $el_text: "sk-live-abc123", surface: "secrets_panel" }),
    )!;
    expect((out.properties as Record<string, unknown>).$el_text).toBeUndefined();
  });

  it("scrubs $elements attributes on a secrets surface but keeps class/id", () => {
    const out = beforeSend(
      capture("$autocapture", {
        object: "secret",
        $elements: [{ $el_text: "sk-live-abc", attr__aria_label: "copy sk-live-abc", attr__class: "btn", attr__id: "copy" }],
      }),
    )!;
    const el = (out.properties as { $elements: Record<string, unknown>[] }).$elements[0];
    expect(el.$el_text).toBeUndefined();
    expect(el.attr__aria_label).toBeUndefined();
    expect(el.attr__class).toBe("btn");
    expect(el.attr__id).toBe("copy");
  });

  it("collapses $host so it aggregates like $current_url", () => {
    const out = beforeSend(
      capture("$autocapture", { $host: "127.0.0.1:57070" }, { $set_once: { $initial_host: "127.0.0.1:57070" } }),
    )!;
    expect((out.properties as Record<string, unknown>).$host).toBe("localhost");
    expect((out.$set_once as Record<string, unknown>).$initial_host).toBe("localhost");
  });

  describe("user-named objects", () => {
    // Real values production has shipped us via $el_text.
    it("drops the label on an agent row — it is a name its owner wrote", () => {
      const out = beforeSend(
        capture("$autocapture", { $el_text: "fetch-recent-weather", object: "agent", surface: "agent_rail" }),
      )!;
      const props = out.properties as Record<string, unknown>;
      expect(props.$el_text).toBeUndefined();
      // The surface survives: we still know a rail row was clicked.
      expect(props.surface).toBe("agent_rail");
    });

    it("strips the name from both element carriers, not just $el_text", () => {
      const out = beforeSend(
        capture("$autocapture", {
          object: "agent",
          $elements: [{ $el_text: "twitter-run", "attr__aria-label": "twitter-run", attr__class: "workflow-item" }],
          $elements_chain: 'button.workflow-item:attr__aria-label="twitter-run"text="twitter-run"nth-child="1"',
        }),
      )!;
      const props = out.properties as { $elements: Record<string, unknown>[]; $elements_chain: string };
      expect(props.$elements[0].$el_text).toBeUndefined();
      expect(props.$elements[0]["attr__aria-label"]).toBeUndefined();
      // Our own class stays — Actions and heatmaps match on it.
      expect(props.$elements[0].attr__class).toBe("workflow-item");
      expect(props.$elements_chain).not.toContain("twitter-run");
      expect(props.$elements_chain).toContain("workflow-item");
    });

    it("KEEPS a template's name — that string is ours, not the user's", () => {
      const out = beforeSend(
        capture("$autocapture", { $el_text: "Newsletter Autopilot", object: "template" }),
      )!;
      expect((out.properties as Record<string, unknown>).$el_text).toBe("Newsletter Autopilot");
    });
  });

  describe("accessible-name promotion", () => {
    it("labels an icon-only button from its aria-label in the chain", () => {
      const out = beforeSend(
        capture("$autocapture", {
          // posthog-js leaves $el_text unset: the click landed on the <svg>.
          $elements_chain:
            'svg.lucide:attr__aria-hidden="true"nth-child="1";button.composer-send:attr__aria-label="Start session"attr__class="composer-send"',
        }),
      )!;
      const props = out.properties as Record<string, unknown>;
      expect(props.$el_text).toBe("Start session");
      expect(props.el_text_source).toBe("aria_label");
    });

    it("prefers the nearest accessible name in $elements", () => {
      const out = beforeSend(
        capture("$autocapture", {
          $elements: [
            { attr__class: "icon" },
            { "attr__aria-label": "Go back" },
            { "attr__aria-label": "Go back or forward" },
          ],
        }),
      )!;
      expect((out.properties as Record<string, unknown>).$el_text).toBe("Go back");
    });

    it("never overwrites real text, and marks nothing when it did not act", () => {
      const out = beforeSend(
        capture("$autocapture", {
          $el_text: "Deploy",
          $elements_chain: 'button:attr__aria-label="Deploy this agent"',
        }),
      )!;
      const props = out.properties as Record<string, unknown>;
      expect(props.$el_text).toBe("Deploy");
      expect(props.el_text_source).toBeUndefined();
    });

    it("does NOT promote on a user-named object — the label is what we are hiding", () => {
      const out = beforeSend(
        capture("$autocapture", {
          object: "agent",
          $elements_chain: 'button:attr__aria-label="fetch-recent-weather"',
        }),
      )!;
      const props = out.properties as Record<string, unknown>;
      expect(props.$el_text).toBeUndefined();
      expect(props.$elements_chain).not.toContain("fetch-recent-weather");
    });

    it("does NOT promote on a secrets surface", () => {
      const out = beforeSend(
        capture("$autocapture", {
          surface: "secrets_panel",
          $elements_chain: 'button:attr__aria-label="Copy sk-live-abc"',
        }),
      )!;
      expect((out.properties as Record<string, unknown>).$el_text).toBeUndefined();
    });

    it("ignores aria-hidden and aria-labelledby", () => {
      const out = beforeSend(
        capture("$autocapture", {
          $elements_chain: 'svg:attr__aria-hidden="true"attr__aria-labelledby="x"nth-child="1"',
        }),
      )!;
      expect((out.properties as Record<string, unknown>).$el_text).toBeUndefined();
    });
  });

  it("never throws — passes the event through if a property is malformed", () => {
    // A getter that throws should not take down capture.
    const props: Record<string, unknown> = {};
    Object.defineProperty(props, "$current_url", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });
    expect(() => beforeSend(capture("$autocapture", props))).not.toThrow();
  });
});
