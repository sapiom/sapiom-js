import { useEffect, useId, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { formatPayload } from "../lib/format-payload";
import { Icon } from "./Icon";

const COLLECTION_PREVIEW = 8;
const TEXT_PREVIEW_CHARS = 1_200;
const TEXT_PREVIEW_LINES = 12;

export interface ArtifactTextPreview {
  kind: "html" | "text";
  truncated: boolean;
  preview: string;
  omittedCharacters: number;
}

function looksLikeHtml(text: string): boolean {
  return /<\/?(?:!doctype|html|head|body|style|script|main|section|article|div|span|img|svg|meta|link)\b/i.test(
    text,
  );
}

/** A deterministic content budget shared by rendered strings and Raw mode. */
export function artifactTextPreview(text: string): ArtifactTextPreview {
  const lines = text.split(/\r?\n/);
  const lineBounded = lines.slice(0, TEXT_PREVIEW_LINES).join("\n");
  const bounded = lineBounded.slice(0, TEXT_PREVIEW_CHARS);
  const truncated = lines.length > TEXT_PREVIEW_LINES || text.length > bounded.length;
  return {
    kind: looksLikeHtml(text) ? "html" : "text",
    truncated,
    preview: truncated ? `${bounded.trimEnd()}\n…` : text,
    omittedCharacters: truncated ? Math.max(0, text.length - bounded.length) : 0,
  };
}

function fallbackCopy(text: string): boolean {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

function safeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function extension(url: URL): string {
  return url.pathname.split(".").pop()?.toLowerCase() ?? "";
}

function linkLabel(url: URL): string {
  const tail = url.pathname.split("/").filter(Boolean).pop();
  if (!tail) return url.hostname;
  try {
    return `${url.hostname} / ${decodeURIComponent(tail)}`;
  } catch {
    // A malformed percent escape is still a valid URL pathname. Rendering a
    // result must never fail just because its human label cannot be decoded.
    return `${url.hostname} / ${tail}`;
  }
}

function MediaValue({ url }: { url: URL }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const ext = extension(url);
  const label = linkLabel(url);
  const image = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(ext);
  const audio = ["mp3", "wav", "ogg", "m4a", "aac"].includes(ext);
  const video = ["mp4", "webm", "mov", "m4v"].includes(ext);
  const downloadable = ["pdf", "zip", "csv", "json", "docx", "xlsx", "pptx", "txt"].includes(ext);

  if (failed || (!image && !audio && !video)) {
    return (
      <a className="artifact-link" href={url.href} target="_blank" rel="noreferrer" download={downloadable || undefined}>
        <Icon name={failed ? "TriangleAlert" : downloadable ? "ArrowDown" : "ExternalLink"} size={13} />
        <span>{failed ? `Preview unavailable · ${label}` : downloadable ? `Download · ${label}` : label}</span>
      </a>
    );
  }

  if (image) {
    return (
      <figure className="artifact-media">
        <img src={url.href} alt={label} loading="lazy" onError={() => setFailed(true)} />
        <figcaption>
          <a href={url.href} target="_blank" rel="noreferrer">{label}</a>
        </figcaption>
      </figure>
    );
  }

  if (audio) {
    return (
      <figure className="artifact-media">
        <audio controls preload="metadata" onError={() => setFailed(true)}>
          <source src={url.href} />
        </audio>
        <figcaption><a href={url.href} target="_blank" rel="noreferrer">{label}</a></figcaption>
      </figure>
    );
  }

  return (
    <figure className="artifact-media">
      <video controls preload="metadata" onError={() => setFailed(true)}>
        <source src={url.href} />
      </video>
      <figcaption><a href={url.href} target="_blank" rel="noreferrer">{label}</a></figcaption>
    </figure>
  );
}

function inlineMarkdown(text: string): ReactNode[] {
  const result: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) result.push(text.slice(cursor, match.index));
    const href = match[2] ?? match[3];
    const url = href ? safeUrl(href.replace(/[.,;!?]+$/, "")) : null;
    if (url) {
      result.push(
        <a key={`${match.index}-${url.href}`} href={url.href} target="_blank" rel="noreferrer">
          {match[1] ?? linkLabel(url)}
        </a>,
      );
    } else {
      result.push(match[0]);
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) result.push(text.slice(cursor));
  return result;
}

/** Safe markdown subset: React nodes only, so embedded HTML remains text. */
function MarkdownValue({ text }: { text: string }): JSX.Element {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join("\n");
    blocks.push(<p key={`p-${blocks.length}`}>{inlineMarkdown(joined)}</p>);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`l-${blocks.length}`}>
        {list.map((item, index) => <li key={index}>{inlineMarkdown(item)}</li>)}
      </ul>,
    );
    list = [];
  };
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const content = inlineMarkdown(heading[2]!);
      blocks.push(
        heading[1]!.length === 1 ? <h3 key={blocks.length}>{content}</h3> :
          heading[1]!.length === 2 ? <h4 key={blocks.length}>{content}</h4> :
            <h5 key={blocks.length}>{content}</h5>,
      );
    } else if (bullet) {
      flushParagraph();
      list.push(bullet[1]!);
    } else if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return <div className="artifact-markdown">{blocks}</div>;
}

function TextValue({ text, forceSource = false }: { text: string; forceSource?: boolean }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const preview = artifactTextPreview(text);
  const source = forceSource || preview.kind === "html";
  const visible = expanded ? text : preview.preview;
  return (
    <div className="artifact-text" data-kind={source ? "source" : "text"}>
      {source ? (
        <pre className="artifact-source">{visible}</pre>
      ) : (
        <MarkdownValue text={visible} />
      )}
      {preview.truncated && (
        <button
          type="button"
          className="btn-ghost artifact-text-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={12} />
          {expanded
            ? "Show less"
            : `Show full ${source ? "HTML" : "text"} · ${preview.omittedCharacters.toLocaleString()} more characters`}
        </button>
      )}
    </div>
  );
}

function isCompositeValue(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function StructuredValue({ value, depth = 0 }: { value: unknown; depth?: number }): JSX.Element {
  if (typeof value === "string") {
    const url = safeUrl(value);
    return url ? <MediaValue url={url} /> : <TextValue text={value} />;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return <code className="artifact-scalar">{String(value)}</code>;
  }
  if (Array.isArray(value)) {
    const visible = value.slice(0, COLLECTION_PREVIEW);
    const rest = value.slice(COLLECTION_PREVIEW);
    return (
      <div className="artifact-list">
        {visible.map((item, index) => (
          <div className="artifact-list-item" data-composite={isCompositeValue(item) || undefined} key={index}>
            <span className="artifact-list-index">{index + 1}</span>
            <StructuredValue value={item} depth={depth + 1} />
          </div>
        ))}
        {rest.length > 0 && (
          <details className="artifact-collection-more">
            <summary>Show {rest.length} more</summary>
            {rest.map((item, index) => (
              <div
                className="artifact-list-item"
                data-composite={isCompositeValue(item) || undefined}
                key={index + COLLECTION_PREVIEW}
              >
                <span className="artifact-list-index">{index + COLLECTION_PREVIEW + 1}</span>
                <StructuredValue value={item} depth={depth + 1} />
              </div>
            ))}
          </details>
        )}
      </div>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const visible = entries.slice(0, COLLECTION_PREVIEW);
    const rest = entries.slice(COLLECTION_PREVIEW);
    const rows = (items: Array<[string, unknown]>): JSX.Element[] =>
      items.map(([key, child]) => (
        <div className="artifact-field" data-composite={isCompositeValue(child) || undefined} key={key}>
          <div className="artifact-field-label">{key.replaceAll(/[_-]+/g, " ")}</div>
          <div className="artifact-field-value"><StructuredValue value={child} depth={depth + 1} /></div>
        </div>
      ));
    return (
      <div className="artifact-object">
        {rows(visible)}
        {rest.length > 0 && (
          <details className="artifact-collection-more">
            <summary>Show {rest.length} more fields</summary>
            {rows(rest)}
          </details>
        )}
      </div>
    );
  }
  return <code className="artifact-scalar">{String(value)}</code>;
}

export function ArtifactRenderer({
  value,
  label = "Result",
  testId = "run-artifact",
  defaultOpen = true,
  onViewed,
}: {
  value: unknown;
  label?: string;
  testId?: string;
  defaultOpen?: boolean;
  onViewed?: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const reported = useRef(false);
  const bodyId = useId();
  const raw = formatPayload(value);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    onViewed?.();
  }, [onViewed]);
  return (
    <section className="artifact-renderer" data-testid={testId} data-collapsed={!open || undefined}>
      <header className="artifact-header">
        <button
          type="button"
          className="artifact-disclosure"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} />
          <span className="artifact-title">{label}</span>
        </button>
        <div className="artifact-actions">
          <div className="artifact-mode" role="tablist" aria-label={`${label} display`}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "rendered"}
              onClick={() => setMode("rendered")}
            >Rendered</button>
            <button type="button" role="tab" aria-selected={mode === "raw"} onClick={() => setMode("raw")}>Raw</button>
          </div>
          <button
            type="button"
            className="btn-ghost artifact-copy"
            onClick={() => void (async () => {
              let didCopy = false;
              try {
                if (navigator.clipboard?.writeText) {
                  await navigator.clipboard.writeText(raw);
                  didCopy = true;
                }
              } catch {
                // The permission can be denied in desktop/webview contexts;
                // the selection fallback below still gives Copy a chance.
              }
              if (!didCopy) didCopy = fallbackCopy(raw);
              if (!didCopy) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })()}
          >
            <Icon name={copied ? "Check" : "Copy"} size={12} /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </header>
      {open && (
        <div className="artifact-body" id={bodyId}>
          {mode === "rendered" ? <StructuredValue value={value} /> : <TextValue text={raw} forceSource />}
        </div>
      )}
    </section>
  );
}
