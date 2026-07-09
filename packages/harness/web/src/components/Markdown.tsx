/**
 * Shared safe-subset markdown renderer — used by ChatView (assistant turns)
 * and SkillsPanel (skill body).
 *
 * Supports the union of both surfaces' feature sets:
 *   - ATX headings (# ## ###)
 *   - Fenced code blocks (``` ... ```)
 *   - Blank-line-separated paragraphs
 *   - Unordered lists (- * +)
 *   - Task-list items (- [ ] / - [x])
 *   - Bold (**text**), italic (*text*)
 *   - Inline backtick code
 *   - Blockquotes (> text)
 *
 * Implemented without dangerouslySetInnerHTML — builds a React element tree
 * from the markdown string. Safe to call with untrusted strings.
 *
 * CSS class namespace: chat-* (matches ChatView's existing styles).
 */
import type { JSX } from "react";

export function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.split("\n");
  const elements: JSX.Element[] = [];
  let i = 0;
  let key = 0;

  function nextKey(): number {
    return key++;
  }

  function renderInline(line: string): (string | JSX.Element)[] {
    const parts: (string | JSX.Element)[] = [];
    // Regex: code (`...`), bold (**...**), italic (*...*)
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      if (match.index > last) {
        parts.push(line.slice(last, match.index));
      }
      const token = match[0];
      if (token.startsWith("`") && token.endsWith("`")) {
        parts.push(<code key={nextKey()} className="chat-inline-code">{token.slice(1, -1)}</code>);
      } else if (token.startsWith("**") && token.endsWith("**")) {
        parts.push(<strong key={nextKey()}>{token.slice(2, -2)}</strong>);
      } else if (token.startsWith("*") && token.endsWith("*")) {
        parts.push(<em key={nextKey()}>{token.slice(1, -1)}</em>);
      } else {
        parts.push(token);
      }
      last = match.index + token.length;
    }
    if (last < line.length) {
      parts.push(line.slice(last));
    }
    return parts;
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      elements.push(
        <pre key={nextKey()} className="chat-code-block" data-lang={lang || undefined}>
          <code className={lang ? `language-${lang}` : undefined}>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // ATX headings (# ## ###)
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      const Tag = (`h${level}`) as "h1" | "h2" | "h3";
      elements.push(
        <Tag key={nextKey()} className="chat-heading">
          {renderInline(headingMatch[2])}
        </Tag>,
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      elements.push(
        <blockquote key={nextKey()} className="chat-blockquote">
          {renderInline(line.slice(2))}
        </blockquote>,
      );
      i++;
      continue;
    }

    // Task-list items (- [ ] or - [x]) — must come before plain list check
    if (/^- \[[ x]\]/.test(line)) {
      const items: Array<{ text: string; checked: boolean }> = [];
      while (i < lines.length && /^- \[[ x]\]/.test(lines[i])) {
        const checked = lines[i][3] === "x";
        items.push({ text: lines[i].replace(/^- \[[ x]\]\s?/, ""), checked });
        i++;
      }
      elements.push(
        <ul key={nextKey()} className="chat-list chat-checklist">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item.text)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Unordered list items (- * +)
    if (/^[-*+]\s+/.test(line)) {
      const listItems: JSX.Element[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^[-*+]\s+/, "");
        listItems.push(<li key={nextKey()}>{renderInline(itemText)}</li>);
        i++;
      }
      elements.push(<ul key={nextKey()} className="chat-list">{listItems}</ul>);
      continue;
    }

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph
    elements.push(
      <p key={nextKey()} className="chat-paragraph">
        {renderInline(line)}
      </p>,
    );
    i++;
  }

  return <>{elements}</>;
}
