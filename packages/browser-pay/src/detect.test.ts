import { redactHeld, textHoldsPlaceholderNumber } from "./detect";

const NUMBER = "4242424242424242";

function encodedDigits(digits: string): string {
  return [...digits].map((digit) => `%3${digit}`).join("");
}

describe("redactHeld", () => {
  it("masks grouped and encoded placeholder digits", () => {
    const values = [
      `https://checkout.example/pay?number=${NUMBER}`,
      "https://checkout.example/pay?number=4242 4242 4242 4242",
      "https://checkout.example/pay?number=4242-4242-4242-4242",
      "https://checkout.example/pay?number=4242+4242+4242+4242",
      "https://checkout.example/pay?number=4242%204242%204242%204242",
      "https://checkout.example/pay?number=4242%2D4242%2d4242%2D4242",
      "https://checkout.example/pay?number=4242\\u00204242\\u00204242\\u00204242",
      `https://checkout.example/pay?number=${encodedDigits(NUMBER)}`,
    ];
    for (const value of values) {
      expect(textHoldsPlaceholderNumber(value, NUMBER)).toBe(true);
      const redacted = redactHeld(value, NUMBER);
      expect(redacted).not.toContain("4242");
      expect(redacted).not.toContain("%34");
      expect(textHoldsPlaceholderNumber(redacted, NUMBER)).toBe(false);
    }
  });

  it("leaves a url that does not hold the placeholder", () => {
    const url = "https://shop.example/orders/100";
    expect(redactHeld(url, NUMBER)).toBe(url);
  });
});
