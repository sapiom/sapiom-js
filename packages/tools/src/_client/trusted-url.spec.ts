import { CredentialChannelError } from "@sapiom/analytics-core/credential";
import { assertTrustedServiceUrl } from "./trusted-url.js";

const LABEL = "test";

describe("assertTrustedServiceUrl", () => {
  it.each([
    [
      "the base host itself",
      "https://api.sapiom.ai/x",
      "https://api.sapiom.ai",
    ],
    [
      "a sibling service of the llm base",
      "https://litellm.services.sapiom.ai/v2/anthropic/v1/messages",
      "https://llm.services.sapiom.ai",
    ],
    [
      "a media service under the Core base's parent",
      "https://fal.services.sapiom.ai/queue/x",
      "https://api.sapiom.ai",
    ],
    [
      "a loopback URL with a loopback base",
      "http://127.0.0.1:4000/queue/x",
      "http://localhost:3000",
    ],
    ["the bare base host", "https://sapiom.ai/x", "https://sapiom.ai"],
  ])("accepts %s", (_label, url, base) => {
    expect(() => assertTrustedServiceUrl(url, base, LABEL)).not.toThrow();
  });

  it.each([
    ["a foreign host", "https://evil.example/queue/x", "https://api.sapiom.ai"],
    [
      "a look-alike suffix",
      "https://evilsapiom.ai/queue/x",
      "https://api.sapiom.ai",
    ],
    [
      "a subdomain when the base has no parent domain",
      "https://api.sapiom.ai/x",
      "https://sapiom.ai",
    ],
    [
      "another host under the base's top-level domain",
      "https://other.ai/x",
      "https://sapiom.ai",
    ],
    [
      "a loopback URL with a remote base",
      "http://127.0.0.1:4000/x",
      "https://api.sapiom.ai",
    ],
    ["an unparsable URL", "not a url", "https://api.sapiom.ai"],
  ])("refuses %s", (_label, url, base) => {
    expect(() => assertTrustedServiceUrl(url, base, LABEL)).toThrow(
      CredentialChannelError,
    );
  });

  it("names origins only, never the path or query", () => {
    expect(() =>
      assertTrustedServiceUrl(
        "https://evil.example/queue/x?token=secret",
        "https://api.sapiom.ai/base/path",
        LABEL,
      ),
    ).toThrow(
      /^test: https:\/\/evil\.example is outside the configured service origin https:\/\/api\.sapiom\.ai;/,
    );
  });
});
