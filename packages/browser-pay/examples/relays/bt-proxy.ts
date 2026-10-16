import type { HeldPlaceholder, PaymentRelay } from "../../src/index.js";
import { SHOPIFY_PAYMENTS_TEST_CARD } from "./shopify-payments-test-card.js";
import {
  forwardRequestHeaders,
  providerResponseHeaders,
  relayBodyText,
  replacePlaceholderCard,
} from "./replace-card.js";

/**
 * Demo stand-in for W3 B6. Not part of the published SDK.
 * Sends the paused Shopify card-session request through Basis Theory's
 * ephemeral proxy. The placeholder number, expiry, and CVC are replaced with
 * token expressions; Basis Theory inserts the vaulted card. Reads
 * BT_PRIVATE_KEY and BT_TOKEN_ID from the environment when constructed from
 * `btProxyRelayFromEnv`. Never logs the key, the token id, or a card value.
 */

export interface CreatedCardToken {
  tokenId: string;
  /** Deletes the token. A failed delete is logged as a status code only. */
  release: () => Promise<void>;
}

export interface BtAccess {
  apiKey: string;
  /** True when this run created a private application from a management key. */
  createdApplication: boolean;
  /** No-op for a private key. Deletes an application created for a management key. */
  release: () => Promise<void>;
}

const PRIVATE_APP_PERMISSIONS = [
  "token:create",
  "token:delete",
  "token:use",
  "proxy:invoke",
] as const;

async function safeFailure(response: Response, action: string): Promise<Error> {
  let extra = "";
  try {
    const body = (await response.json()) as {
      title?: unknown;
      detail?: unknown;
    };
    const title = typeof body.title === "string" ? body.title : "";
    const detail = typeof body.detail === "string" ? body.detail : "";
    const combined = [title, detail].filter(Boolean).join(": ");
    if (
      combined &&
      combined.length <= 180 &&
      !/key_|[0-9a-f]{8}-[0-9a-f]{4}/i.test(combined) &&
      !/\d(?:\s*\d){11,}/.test(combined)
    ) {
      extra = `: ${combined}`;
    }
  } catch {
    // The status is enough when the body is not JSON.
  }
  return new Error(
    `Basis Theory ${action} failed (HTTP ${response.status}${extra})`,
  );
}

function btBaseUrl(baseUrl?: string): string {
  return (
    baseUrl ??
    process.env.BT_API_BASE ??
    "https://api.basistheory.com"
  ).replace(/\/$/, "");
}

/**
 * Vault Shopify Payments' published test card in the Basis Theory test tenant.
 * The PAN is sent only on this create call. The relay then uses token expressions.
 */
export async function createShopifyPaymentsTestToken(options: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<CreatedCardToken> {
  if (!options.apiKey) {
    throw new Error("BT_PRIVATE_KEY is required to create a card token");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = btBaseUrl(options.baseUrl);
  const card = SHOPIFY_PAYMENTS_TEST_CARD;
  const response = await fetchImpl(`${base}/tokens`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "BT-API-KEY": options.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "card",
      data: {
        number: card.number,
        expiration_month: card.expMonth,
        expiration_year: card.expYear,
        cvc: card.cvc,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Basis Theory token create refused a redirect");
  }
  if (!response.ok) throw await safeFailure(response, "token create");
  const payload = (await response.json()) as { id?: unknown };
  const tokenId = payload.id;
  if (typeof tokenId !== "string" || !/^[A-Za-z0-9._:-]+$/.test(tokenId)) {
    throw new Error("Basis Theory token create returned no token id");
  }
  return {
    tokenId,
    release: async () => {
      try {
        const deleted = await fetchImpl(
          `${base}/tokens/${encodeURIComponent(tokenId)}`,
          {
            method: "DELETE",
            redirect: "manual",
            headers: { "BT-API-KEY": options.apiKey },
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!deleted.ok && deleted.status !== 404) {
          console.error(
            `Basis Theory token delete failed (HTTP ${deleted.status})`,
          );
        }
        await deleted.arrayBuffer().catch(() => undefined);
      } catch {
        console.error("Basis Theory token delete failed");
      }
    },
  };
}

/**
 * A private application key that can create a card token and invoke the proxy.
 * `BT_PRIVATE_KEY` in this environment may be a management key, which cannot
 * do either. A management key creates a private application for this run.
 * The application is deleted by `release`. The returned key is never logged.
 */
export async function btAccessFromKey(options: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<BtAccess> {
  if (!options.apiKey) {
    throw new Error("BT_PRIVATE_KEY is required");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = btBaseUrl(options.baseUrl);
  const current = await fetchImpl(`${base}/applications/key`, {
    method: "GET",
    redirect: "manual",
    headers: { "BT-API-KEY": options.apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (current.status >= 300 && current.status < 400) {
    throw new Error("Basis Theory application lookup refused a redirect");
  }
  if (!current.ok) {
    await current.arrayBuffer().catch(() => undefined);
    return {
      apiKey: options.apiKey,
      createdApplication: false,
      release: async () => {},
    };
  }
  const app = (await current.json()) as { type?: unknown };
  if (app.type !== "management") {
    return {
      apiKey: options.apiKey,
      createdApplication: false,
      release: async () => {},
    };
  }
  const created = await fetchImpl(`${base}/applications`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "BT-API-KEY": options.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "browser-pay demo",
      type: "private",
      permissions: [...PRIVATE_APP_PERMISSIONS],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (created.status >= 300 && created.status < 400) {
    throw new Error("Basis Theory application create refused a redirect");
  }
  if (!created.ok) throw await safeFailure(created, "application create");
  const body = (await created.json()) as {
    id?: unknown;
    keys?: Array<{ key?: unknown }>;
  };
  const applicationId = body.id;
  const privateKey = body.keys?.find(
    (item) => typeof item.key === "string",
  )?.key;
  if (
    typeof applicationId !== "string" ||
    !/^[A-Za-z0-9._:-]+$/.test(applicationId) ||
    typeof privateKey !== "string" ||
    privateKey.length < 8
  ) {
    throw new Error("Basis Theory application create returned no key");
  }
  return {
    apiKey: privateKey,
    createdApplication: true,
    release: async () => {
      try {
        const deleted = await fetchImpl(
          `${base}/applications/${encodeURIComponent(applicationId)}`,
          {
            method: "DELETE",
            redirect: "manual",
            headers: { "BT-API-KEY": options.apiKey },
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!deleted.ok && deleted.status !== 404) {
          console.error(
            `Basis Theory application delete failed (HTTP ${deleted.status})`,
          );
        }
        await deleted.arrayBuffer().catch(() => undefined);
      } catch {
        console.error("Basis Theory application delete failed");
      }
    },
  };
}

export function btProxyRelay(options: {
  placeholder: HeldPlaceholder;
  apiKey: string;
  tokenId: string;
  /** Defaults to `https://api.basistheory.com`, or `BT_API_BASE` when omitted. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): PaymentRelay {
  if (!/^[A-Za-z0-9._:-]+$/.test(options.tokenId)) {
    throw new Error("BT token id is not a usable token id");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = btBaseUrl(options.baseUrl);
  const expression = (path: string) =>
    `{{ token: ${options.tokenId} | json: '$.data.${path}' }}`;
  return {
    async relay(request) {
      const body = replacePlaceholderCard(
        relayBodyText(request),
        options.placeholder.number,
        {
          number: expression("number"),
          expMonth: expression("expiration_month"),
          expYear: expression("expiration_year"),
          cvc: expression("cvc"),
        },
      );
      const response = await fetchImpl(`${base}/proxy`, {
        method: "POST",
        redirect: "manual",
        headers: {
          ...forwardRequestHeaders(request.headers),
          "BT-API-KEY": options.apiKey,
          "BT-PROXY-URL": request.url,
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("Payment relay refused a redirect");
      }
      const destination = Number(
        response.headers.get("bt-proxy-destination-status"),
      );
      const hasDestination =
        Number.isInteger(destination) &&
        destination >= 100 &&
        destination <= 599;
      if (
        !hasDestination &&
        (response.status < 200 || response.status >= 300)
      ) {
        throw new Error(`Payment relay failed (HTTP ${response.status})`);
      }
      return {
        ok: true,
        status: hasDestination ? destination : response.status,
        headers: providerResponseHeaders(response.headers),
        body: await response.text(),
        bodyEncoding: "utf8",
      };
    },
  };
}

export function btProxyRelayFromEnv(
  placeholder: HeldPlaceholder,
): PaymentRelay {
  const apiKey = process.env.BT_PRIVATE_KEY;
  const tokenId = process.env.BT_TOKEN_ID;
  if (!apiKey || !tokenId) {
    throw new Error("BT_PRIVATE_KEY and BT_TOKEN_ID are required for RELAY=bt");
  }
  return btProxyRelay({ placeholder, apiKey, tokenId });
}
