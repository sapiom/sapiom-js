export interface HeldPlaceholder {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  injectionRef: string;
}

function placeholderDigits(number: string): string | undefined {
  const digits = number.replace(/[\s-]/g, "");
  if (digits.length === 0 || !/^\d+$/.test(digits)) return undefined;
  return digits;
}

function separatorLength(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === 32 || code === 9 || code === 45 || code === 43) return 1;
  if (
    text.startsWith("%20", index) ||
    text.startsWith("%2D", index) ||
    text.startsWith("%2d", index)
  ) {
    return 3;
  }
  if (
    text.startsWith("\\u0020", index) ||
    text.startsWith("\\u002D", index) ||
    text.startsWith("\\u002d", index)
  ) {
    return 6;
  }
  return 0;
}

function holdsDigits(text: string, digits: string): boolean {
  const last = text.length - digits.length;
  for (let start = 0; start <= last; start++) {
    if (text[start] !== digits[0]) continue;
    let index = start + 1;
    let matched = true;
    for (let digit = 1; digit < digits.length; digit++) {
      const skip = separatorLength(text, index);
      if (skip > 0 && text[index + skip] === digits[digit]) index += skip;
      if (text[index] !== digits[digit]) {
        matched = false;
        break;
      }
      index += 1;
    }
    if (matched) return true;
  }
  return false;
}

function decodeForSearch(text: string): string {
  const withUnicode = text.replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)),
  );
  const plus = withUnicode.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

export function textHoldsPlaceholderNumber(
  text: string,
  number: string,
): boolean {
  if (number.length === 0 || text.length === 0) return false;
  if (text.includes(number)) return true;
  const digits = placeholderDigits(number);
  if (!digits) return false;
  if (holdsDigits(text, digits)) return true;
  const decoded = decodeForSearch(text);
  if (decoded === text) return false;
  return decoded.includes(number) || holdsDigits(decoded, digits);
}

function isSeparatorChar(char: string): boolean {
  return char === " " || char === "\t" || char === "-" || char === "+";
}

function readDecoded(
  text: string,
  index: number,
): { char: string; next: number } {
  if (index >= text.length) return { char: "", next: index };
  if (text.startsWith("\\u", index)) {
    const hex = text.slice(index + 2, index + 6);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      return {
        char: String.fromCharCode(Number.parseInt(hex, 16)),
        next: index + 6,
      };
    }
  }
  if (text[index] === "+") return { char: " ", next: index + 1 };
  if (text[index] === "%" && index + 2 < text.length) {
    const encoded = text.slice(index, index + 3);
    if (/^%[0-9a-fA-F]{2}$/.test(encoded)) {
      try {
        const char = decodeURIComponent(encoded);
        if (char.length === 1) return { char, next: index + 3 };
      } catch {
        // keep the literal percent
      }
    }
  }
  return { char: text[index] ?? "", next: index + 1 };
}

function heldSpanEnd(
  text: string,
  digits: string,
  start: number,
): number | undefined {
  const first = readDecoded(text, start);
  if (first.char !== digits[0]) return undefined;
  let index = first.next;
  for (let digit = 1; digit < digits.length; digit++) {
    const separator = readDecoded(text, index);
    if (isSeparatorChar(separator.char)) {
      const after = readDecoded(text, separator.next);
      if (after.char === digits[digit]) {
        index = after.next;
        continue;
      }
    }
    const raw = readDecoded(text, index);
    if (raw.char !== digits[digit]) return undefined;
    index = raw.next;
  }
  return index;
}

function maskHeldSpans(text: string, digits: string): string {
  let out = "";
  let cursor = 0;
  for (let start = 0; start < text.length; ) {
    const end = heldSpanEnd(text, digits, start);
    if (end === undefined) {
      start += 1;
      continue;
    }
    out += text.slice(cursor, start);
    out += "••••";
    cursor = end;
    start = end;
  }
  return out + text.slice(cursor);
}

export function redactHeld(value: string, number: string): string {
  if (number.length === 0 || value.length === 0) return value;
  const digits = placeholderDigits(number);
  if (!digits) return value.split(number).join("••••");
  return maskHeldSpans(value, digits);
}
