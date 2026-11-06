import type { CdpConnection } from "./cdp.js";
export type NativeLookup = {
  sessionId: string;
  requestId: string;
  url: string;
  received: boolean;
  result: Promise<string | undefined>;
  resolve: (nonce?: string) => void;
};

export async function readNativeLookup(
  cdp: Pick<CdpConnection, "send">,
  lookup: NativeLookup,
) {
  try {
    const response = (await cdp.send(
      "Network.getResponseBody",
      { requestId: lookup.requestId },
      lookup.sessionId,
      5000,
    )) as { body: string; base64Encoded?: boolean };
    if (typeof response.body !== "string" || response.body.length > 65536)
      return;
    const text = response.base64Encoded
      ? Buffer.from(response.body, "base64").toString("utf8")
      : response.body;
    if (Buffer.byteLength(text) > 32768) return;
    const body = JSON.parse(text);
    const nonce = body.paymentMethod?.nonce;
    if (
      !body.errors?.length &&
      typeof nonce === "string" &&
      nonce.length > 0 &&
      nonce.length <= 255
    )
      lookup.resolve(nonce);
  } catch {
    /* An unavailable lookup leaves the existing challenge native. */
  } finally {
    lookup.resolve();
  }
}

export async function waitNativeLookup(lookup?: NativeLookup) {
  if (!lookup) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup.result,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
