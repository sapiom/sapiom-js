/** Mask a card number to its last four digits. Shorter values collapse. */
export function maskCardNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  return `••••${digits.slice(-4)}`;
}

/**
 * Replace 13–19 digit runs (spaces and dashes allowed) with a last-4 mask.
 * Used on URLs and error text so a number typed into a query string cannot
 * leave the process through an event.
 */
export function redact(value: string): string {
  return value.replace(/\d(?:[\s-]*\d){12,18}/g, (run) => {
    const digits = run.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return run;
    return maskCardNumber(digits);
  });
}
