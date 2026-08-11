/**
 * USD display for the rail's plan card. One rule: whole dollars drop the
 * cents ("$50"), anything fractional keeps exactly two ("$12.40") — so the
 * pair reads "$12.40 / $50", not "$12.40 / $50.00". Sub-cent residue from
 * upstream decimal strings rounds to the displayed cent rather than leaking
 * ("$12.399999…" is a bug report, not a balance).
 */
export function formatUsd(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}
