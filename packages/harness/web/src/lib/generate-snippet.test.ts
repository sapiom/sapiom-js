import { describe, it, expect } from "vitest";

import {
  API_KEY_PLACEHOLDER,
  DEFAULT_BASE_URL,
  generateSnippet,
} from "./generate-snippet.js";

describe("generateSnippet — TypeScript", () => {
  it("renders the exact SDK snippet with slug + sample input", () => {
    const { typescript } = generateSnippet({
      definition: "daily-digest",
      inputSample: { topic: "weekly-summary" },
    });
    expect(typescript).toBe(`import { agents } from "@sapiom/tools";

const result = await agents.run({
  definition: "daily-digest",
  input: {
    "topic": "weekly-summary"
  },
});

if (result.status === "completed") {
  console.log(result.output);
}
`);
  });

  it("uses a comment placeholder (valid TS) when there is no sample input", () => {
    expect(generateSnippet({ definition: "x" }).typescript).toContain(
      "input: { /* your input */ },",
    );
  });

  it("treats a null sample the same as an absent one", () => {
    expect(generateSnippet({ definition: "x", inputSample: null }).typescript).toContain(
      "input: { /* your input */ },",
    );
  });

  it("quotes the definition slug via JSON so it is always a valid string literal", () => {
    expect(generateSnippet({ definition: "my-agent" }).typescript).toContain(
      'definition: "my-agent",',
    );
  });
});

describe("generateSnippet — cURL", () => {
  it("renders the exact HTTP snippet with the default base URL", () => {
    const { curl } = generateSnippet({
      definition: "daily-digest",
      inputSample: { topic: "weekly-summary" },
    });
    expect(curl).toBe(`curl -X POST https://api.sapiom.ai/agents/v1/definitions/daily-digest/executions \\
  -H "x-api-key: YOUR_SAPIOM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "input": {"topic":"weekly-summary"} }'
`);
  });

  it("uses an empty JSON object (not a comment) when there is no sample input", () => {
    expect(generateSnippet({ definition: "x" }).curl).toContain(`-d '{ "input": {} }'`);
  });

  it("honors a base URL override", () => {
    expect(generateSnippet({ definition: "x", baseUrl: "http://localhost:3000" }).curl).toContain(
      "curl -X POST http://localhost:3000/agents/v1/definitions/x/executions",
    );
  });

  it("puts the slug in the URL path", () => {
    expect(generateSnippet({ definition: "lead-enrich" }).curl).toContain(
      "/agents/v1/definitions/lead-enrich/executions",
    );
  });
});

describe("generateSnippet — verified constants (guard against drift)", () => {
  it("exports the ground-truth base URL and key placeholder", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.sapiom.ai");
    expect(API_KEY_PLACEHOLDER).toBe("YOUR_SAPIOM_API_KEY");
  });

  it("uses the x-api-key header and the /executions endpoint", () => {
    const { curl } = generateSnippet({ definition: "x" });
    expect(curl).toContain("x-api-key: YOUR_SAPIOM_API_KEY");
    expect(curl).toContain("/executions");
  });

  it.each([
    ["Authorization:", "wrong auth scheme"],
    ["Bearer", "bearer token, not x-api-key"],
    ["tools.sapiom.ai", "wrong host"],
    ["/triggers", "scheduling endpoint, out of scope"],
  ])("never emits %s (%s) in either snippet", (forbidden) => {
    const { typescript, curl } = generateSnippet({
      definition: "x",
      inputSample: { a: 1 },
    });
    expect(typescript).not.toContain(forbidden);
    expect(curl).not.toContain(forbidden);
  });

  it("never emits anything resembling a real key (only the placeholder)", () => {
    const { curl } = generateSnippet({ definition: "x" });
    // A real Sapiom key would look like sk_… / a long random token; the snippet
    // must only ever carry the literal placeholder.
    expect(curl).not.toMatch(/sk_[A-Za-z0-9]/);
    // Capture up to the closing quote of the -H "…" argument.
    expect(curl.match(/x-api-key: ([^"]+)"/)?.[1]).toBe(API_KEY_PLACEHOLDER);
  });
});
