/**
 * Headers Chrome's network stack adds after the Fetch request stage.
 * Missing ones are filled. A header the request already has is left alone.
 *
 * Sec-Fetch-Site follows the schemeful same-site check. The registrable
 * domain is the last two hostname labels. This repo has no public suffix
 * list, so a multi-label public suffix such as `co.uk` is treated as the
 * site itself: `a.co.uk` and `b.co.uk` are reported same-site. Shopify's
 * card hosts are not in that set.
 */

export type SecFetchSite = "same-origin" | "same-site" | "cross-site";

function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  return labels.slice(-2).join(".");
}

/** Schemeful same-site of `requestUrl` relative to the frame that sent it. */
export function secFetchSite(
  requestUrl: string,
  frameUrl: string,
): SecFetchSite | undefined {
  let target: URL;
  let frame: URL;
  try {
    target = new URL(requestUrl);
    frame = new URL(frameUrl);
  } catch {
    return undefined;
  }
  if (target.origin === frame.origin) return "same-origin";
  if (
    target.protocol === frame.protocol &&
    registrableDomain(target.hostname) === registrableDomain(frame.hostname)
  ) {
    return "same-site";
  }
  return "cross-site";
}

/** Chrome's Accept-Language q-values from `navigator.languages`. */
export function acceptLanguageHeader(languages: readonly string[]): string {
  return languages
    .map((language, index) =>
      index === 0
        ? language
        : `${language};q=${Math.max(0.1, 1 - index / 10).toFixed(1)}`,
    )
    .join(",");
}

export function cookieHeader(
  cookies: readonly { name: string; value: string }[],
): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/** `empty` for fetch and XHR. Other resource types are left unset. */
export function secFetchDest(resourceType: string): "empty" | undefined {
  return resourceType === "Fetch" || resourceType === "XHR"
    ? "empty"
    : undefined;
}
