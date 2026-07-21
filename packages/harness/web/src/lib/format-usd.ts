/**
 * Format a USD-valued credit amount for display on the canvas.
 *
 * Rules:
 *   - NaN / unparseable → "$0.00"
 *   - 0                 → "$0.00"
 *   - >= 1              → "$X.XX" (2 decimal places)
 *   - > 0 && < 1        → up to 4 significant decimal digits, trailing zeros
 *                         trimmed (e.g. 0.809676 → "$0.8097", 0.05 → "$0.05")
 */
export function formatUsd(raw: string | number): string {
  const value = typeof raw === "number" ? raw : parseFloat(raw);

  if (isNaN(value) || value === 0) return "$0.00";

  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }

  // For values between 0 and 1: use 4 significant decimal digits, trim zeros.
  // toPrecision(4) gives 4 significant figures overall; for values < 1 this
  // means at least 1 digit before the leading zeros, so we parse back to a
  // number and re-format to strip trailing zeros.
  const sigFigs = parseFloat(value.toPrecision(4));
  // Format with enough decimal places to show the significant digits.
  // We need at most 4 decimal places for a value like 0.0001 (4 sig figs = 0.0001000... → 4dp).
  // For 0.809676: toPrecision(4) = "0.8097", parseFloat → 0.8097, toFixed(4) → "0.8097".
  // For 0.05: toPrecision(4) = "0.05000", parseFloat → 0.05, toFixed(4) → "0.0500" → trim → "0.05".
  const formatted = sigFigs.toFixed(4).replace(/\.?0+$/, "");
  // Ensure we always have at least 2 decimal places for consistency.
  const dotIndex = formatted.indexOf(".");
  if (dotIndex === -1) return `$${formatted}.00`;
  const decimals = formatted.length - dotIndex - 1;
  if (decimals < 2) return `$${formatted}${"0".repeat(2 - decimals)}`;
  return `$${formatted}`;
}
