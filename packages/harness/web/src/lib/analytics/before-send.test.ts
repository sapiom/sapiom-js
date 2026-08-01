import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";

import { beforeSend, sanitizeUrl } from "./before-send";

function capture(event: string, properties: Record<string, unknown>, extra?: Partial<CaptureResult>): CaptureResult {
  return { event, properties, ...extra } as CaptureResult;
}

describe("sanitizeUrl", () => {
  it("strips the query string (which carries the boot token) and the fragment", () => {
    expect(sanitizeUrl("http://localhost:4100/?token=super-secret")).toBe("http://localhost:4100/");
    expect(sanitizeUrl("http://localhost:4100/workbench?token=x#frag")).toBe("http://localhost:4100/workbench");
  });

  it("passes non-URL / empty values through unchanged", () => {
    expect(sanitizeUrl("not a url")).toBe("not a url");
    expect(sanitizeUrl("")).toBe("");
    expect(sanitizeUrl(undefined)).toBe(undefined);
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
    expect((out.properties as Record<string, unknown>).$current_url).toBe("http://localhost:4100/");
    expect((out.$set_once as Record<string, unknown>).$initial_current_url).toBe("http://localhost:4100/");
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
