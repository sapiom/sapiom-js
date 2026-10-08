/**
 * Resource intake on the new-agent screen (flow-creation.md §4.6 step 1).
 *
 * The idea box used to be the only intake. Two kinds of paste now go
 * somewhere better than the textarea: LINKS are listed as sources and handed
 * to the session by URL (nothing is fetched client-side), and a LONG PASTE
 * becomes an attached document rather than a wall of text the agent has to
 * scroll past. The classification is pure so the thresholds have a unit test
 * and the component only has to act on the answer.
 */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** A paste longer than this is a document, not an idea. */
export const LONG_PASTE_CHARS = 1200;
/** Or one with more lines than an idea has. */
export const LONG_PASTE_LINES = 12;

/** Trailing punctuation a sentence leaves on a link is not part of it. */
function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?]+$/, "");
  // A closing paren without its opener came from the sentence, not the URL.
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1);
  }
  return url;
}

/** Every distinct http(s) link in the text, in order of first appearance. */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.match(URL_RE) ?? []) {
    const url = trimUrl(match);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** True when the text is nothing but links (whitespace-separated). */
export function isOnlyUrls(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => {
    const [match] = token.match(URL_RE) ?? [];
    return match != null && trimUrl(match) === trimUrl(token);
  });
}

export function isLongPaste(text: string): boolean {
  return (
    text.length > LONG_PASTE_CHARS ||
    text.split(/\r?\n/).length > LONG_PASTE_LINES
  );
}

export type PasteIntake =
  | { kind: "links"; urls: string[] }
  | { kind: "document" }
  | { kind: "text" };

/** What to do with pasted text: list it as sources, attach it, or type it. */
export function classifyPaste(text: string): PasteIntake {
  if (isOnlyUrls(text)) return { kind: "links", urls: extractUrls(text) };
  if (isLongPaste(text)) return { kind: "document" };
  return { kind: "text" };
}

/** The file name a pasted document is attached under. */
export function pastedDocumentName(ordinal: number): string {
  return `pasted-${ordinal}.md`;
}

/** "https://www.example.com/blog/changelog?x=1" -> "example.com/blog/changelog":
 *  what a source chip shows. The full URL stays on the chip's title. */
export function urlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/$/, "");
    const label = host + path;
    return label.length > 48 ? `${label.slice(0, 45)}…` : label;
  } catch {
    return url;
  }
}

/** Words in a pasted document, for its chip. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}
