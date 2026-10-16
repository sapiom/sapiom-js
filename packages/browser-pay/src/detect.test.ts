import {
  cardNumberCandidate,
  matchHeldPlaceholder,
  matchHeldPlaceholderInBody,
  textContainsForeignCard,
  textHoldsPlaceholderNumber,
  type HeldPlaceholder,
} from "./detect";
import { maskCardNumber, redact } from "./redact";

const HELD: HeldPlaceholder = {
  number: "4242424242424242",
  expMonth: 12,
  expYear: 2028,
  cvc: "123",
  injectionRef: "inj_test",
};

const json = (card: Record<string, unknown>) =>
  JSON.stringify({ credit_card: card });

describe("cardNumberCandidate", () => {
  it("accepts a Luhn-valid number and strips separators", () => {
    expect(cardNumberCandidate("4242424242424242")).toBe("4242424242424242");
    expect(cardNumberCandidate("4242-4242-4242-4242")).toBe("4242424242424242");
    expect(cardNumberCandidate("4242 4242 4242 4242")).toBe("4242424242424242");
  });

  it("rejects a Luhn failure, a short run, and an unrelated valid number's check", () => {
    expect(cardNumberCandidate("4242424242424243")).toBeNull();
    expect(cardNumberCandidate("424242424242")).toBeNull();
    expect(cardNumberCandidate("not a card")).toBeNull();
  });
});

describe("matchHeldPlaceholder", () => {
  it("matches the held number when expiry and cvc agree, including a two-digit year", () => {
    expect(
      matchHeldPlaceholder(
        { number: "4242424242424242", expMonth: 12, expYear: 28, cvc: "123" },
        [HELD],
      ),
    ).toEqual({ kind: "match", injectionRef: "inj_test" });
  });

  it("returns not_held for a different Luhn-valid number", () => {
    expect(
      matchHeldPlaceholder({ number: "4111111111111111" }, [HELD]),
    ).toEqual({ kind: "not_held" });
  });

  it("returns not_a_card_number when the value fails Luhn", () => {
    expect(
      matchHeldPlaceholder({ number: "4242424242424243" }, [HELD]),
    ).toEqual({ kind: "not_a_card_number" });
  });
});

describe("matchHeldPlaceholderInBody", () => {
  it("matches a JSON body", () => {
    const body = json({
      number: "4242424242424242",
      month: 12,
      year: 2028,
      verification_value: "123",
      name: "Fixture Buyer",
    });
    expect(matchHeldPlaceholderInBody(body, HELD)).toEqual({
      kind: "match",
      injectionRef: "inj_test",
    });
  });

  it("matches a JSON number written with separators", () => {
    const body = json({
      number: "4242-4242-4242-4242",
      month: "12",
      year: "28",
      verification_value: "123",
    });
    expect(matchHeldPlaceholderInBody(body, HELD)).toEqual({
      kind: "match",
      injectionRef: "inj_test",
    });
  });

  it("matches a form body", () => {
    const body =
      "credit_card[number]=4242+4242+4242+4242&credit_card[month]=12&credit_card[year]=2028&credit_card[verification_value]=123";
    expect(matchHeldPlaceholderInBody(body, HELD)).toEqual({
      kind: "match",
      injectionRef: "inj_test",
    });
  });

  it("matches on the number alone when expiry and cvc are absent", () => {
    expect(
      matchHeldPlaceholderInBody(json({ number: "4242 4242 4242 4242" }), HELD),
    ).toEqual({ kind: "match", injectionRef: "inj_test" });
  });

  it("does not treat a Luhn failure as the placeholder", () => {
    expect(
      matchHeldPlaceholderInBody(
        json({
          number: "4242424242424243",
          month: 12,
          year: 2028,
          verification_value: "123",
        }),
        HELD,
      ),
    ).toEqual({ kind: "not_held" });
  });

  it("still sees the placeholder when more digits follow it", () => {
    expect(matchHeldPlaceholderInBody("4242 4242 4242 4242 123", HELD)).toEqual(
      { kind: "match", injectionRef: "inj_test" },
    );
    expect(matchHeldPlaceholderInBody("4242 4242 4242 4242 999", HELD)).toEqual(
      { kind: "mismatch", injectionRef: "inj_test", mismatch: "cvc" },
    );
    expect(
      matchHeldPlaceholderInBody(
        json({ number: "4242 4242 4242 4242 12/28" }),
        HELD,
      ),
    ).toEqual({ kind: "match", injectionRef: "inj_test" });
    expect(
      matchHeldPlaceholderInBody("4242 4242 4242 4242 01/28", HELD),
    ).toEqual({
      kind: "mismatch",
      injectionRef: "inj_test",
      mismatch: "expiry",
    });
    const boundary = "----WebKitFormBoundary123";
    const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="number"\r\n\r\n4242424242424242\r\n--${boundary}--`;
    expect(matchHeldPlaceholderInBody(multipart, HELD)).toEqual({
      kind: "match",
      injectionRef: "inj_test",
    });
  });

  it("mismatches a held number with the wrong cvc", () => {
    expect(
      matchHeldPlaceholderInBody(
        json({
          number: "4242424242424242",
          month: 12,
          year: 2028,
          verification_value: "999",
        }),
        HELD,
      ),
    ).toEqual({ kind: "mismatch", injectionRef: "inj_test", mismatch: "cvc" });
  });

  it("mismatches a held number with the wrong expiry", () => {
    expect(
      matchHeldPlaceholderInBody(
        json({
          number: "4242424242424242",
          month: 1,
          year: 2028,
          verification_value: "123",
        }),
        HELD,
      ),
    ).toEqual({
      kind: "mismatch",
      injectionRef: "inj_test",
      mismatch: "expiry",
    });
    expect(
      matchHeldPlaceholderInBody(
        json({
          number: "4242424242424242",
          month: 12,
          year: 2030,
          verification_value: "123",
        }),
        HELD,
      ),
    ).toEqual({
      kind: "mismatch",
      injectionRef: "inj_test",
      mismatch: "expiry",
    });
  });

  it("returns not_held for an unrelated card number", () => {
    expect(
      matchHeldPlaceholderInBody(
        json({
          number: "4111111111111111",
          month: 12,
          year: 2028,
          verification_value: "123",
        }),
        HELD,
      ),
    ).toEqual({ kind: "not_held" });
  });

  it("returns not_held for an empty body and for digits that are not a card", () => {
    expect(matchHeldPlaceholderInBody("", HELD)).toEqual({ kind: "not_held" });
    expect(matchHeldPlaceholderInBody('{"order":12345}', HELD)).toEqual({
      kind: "not_held",
    });
  });

  it("finds a percent-encoded placeholder and ignores a different Luhn card inside a longer run", () => {
    const encoded = encodeURIComponent("4242 4242 4242 4242");
    expect(textHoldsPlaceholderNumber(encoded, HELD.number)).toBe(true);
    expect(matchHeldPlaceholderInBody(encoded, HELD)).toEqual({
      kind: "match",
      injectionRef: "inj_test",
    });
    expect(textContainsForeignCard("4111111111111111", HELD.number)).toBe(true);
    expect(textContainsForeignCard(HELD.number, HELD.number)).toBe(false);
    expect(textContainsForeignCard('{"id":"west-fixture"}', HELD.number)).toBe(
      false,
    );
  });
});

describe("redact", () => {
  it("masks a card number to last4 and leaves short numbers", () => {
    expect(maskCardNumber("4242424242424242")).toBe("••••4242");
    expect(redact("pan 4242-4242-4242-4242 end")).toBe("pan ••••4242 end");
    expect(redact("order 1001")).toBe("order 1001");
  });
});
