export interface HeldCard {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
}

function yearMatches(value: unknown, heldYear: number): boolean {
  const year = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(year)) return false;
  if (year === heldYear) return true;
  return year >= 0 && year < 100 && 2000 + year === heldYear;
}

function monthMatches(value: unknown, heldMonth: number): boolean {
  const month = typeof value === "number" ? value : Number(value);
  return Number.isInteger(month) && month === heldMonth;
}

export function strictCardSession(body: string, held: HeldCard): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const card = (parsed as { credit_card?: unknown }).credit_card;
  if (!card || typeof card !== "object") return false;
  const fields = card as Record<string, unknown>;
  if (typeof fields.number !== "string" || fields.number !== held.number) {
    return false;
  }
  if (!monthMatches(fields.month, held.expMonth)) return false;
  if (!yearMatches(fields.year, held.expYear)) return false;
  const cvc =
    typeof fields.verification_value === "string"
      ? fields.verification_value
      : typeof fields.verification_value === "number"
        ? String(fields.verification_value)
        : "";
  return cvc === held.cvc;
}
