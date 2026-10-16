import {
  luhnHeldPan,
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

const FOREIGN: HeldPlaceholder = {
  ...HELD,
  number: "4111111111111111",
  injectionRef: "inj_foreign",
};

describe("luhn gate", () => {
  it("accepts a Luhn-valid number and rejects a check-digit failure", () => {
    expect(luhnHeldPan("4242 4242 4242 4242")).toBe("4242424242424242");
    expect(luhnHeldPan("4242424242424243")).toBeNull();
    expect(luhnHeldPan("424242424242")).toBeNull();
  });

  it("does not match when the held number fails Luhn", () => {
    const held: HeldPlaceholder = { ...HELD, number: "4242424242424243" };
    expect(
      matchHeldPlaceholderInBody(
        JSON.stringify({ number: "4242424242424243" }),
        held,
      ),
    ).toEqual({ kind: "not_held" });
  });
});

describe("matchHeldPlaceholderInBody", () => {
  it("matches the held number anywhere, including grouped digits", () => {
    expect(
      matchHeldPlaceholderInBody(`note 4242 4242 4242 4242 trailing`, HELD),
    ).toEqual({ kind: "match", injectionRef: "inj_test" });
    expect(matchHeldPlaceholderInBody("4242-4242-4242-4242", HELD)).toEqual({
      kind: "match",
      injectionRef: "inj_test",
    });
  });

  it("matches a JSON body and a form body without comparing expiry or cvc", () => {
    const json = JSON.stringify({
      credit_card: {
        number: "4242 4242 4242 4242",
        month: 1,
        year: 1999,
        verification_value: "999",
      },
    });
    expect(matchHeldPlaceholderInBody(json, HELD)).toEqual({
      kind: "match",
      injectionRef: "inj_test",
    });
    const form =
      "credit_card[number]=4242+4242+4242+4242&credit_card[month]=1&credit_card[verification_value]=000";
    expect(matchHeldPlaceholderInBody(form, HELD)).toEqual({
      kind: "match",
      injectionRef: "inj_test",
    });
  });

  it("matches percent-encoded and JSON-escaped separators", () => {
    expect(
      textHoldsPlaceholderNumber(
        encodeURIComponent("4242 4242 4242 4242"),
        HELD.number,
      ),
    ).toBe(true);
    expect(
      matchHeldPlaceholderInBody("4242%204242%204242%204242", HELD),
    ).toEqual({ kind: "match", injectionRef: "inj_test" });
    expect(
      matchHeldPlaceholderInBody("4242\\u00204242\\u00204242\\u00204242", HELD),
    ).toEqual({ kind: "match", injectionRef: "inj_test" });
  });

  it("does not match a foreign Luhn-valid number", () => {
    const body = JSON.stringify({
      credit_card: { number: "4111111111111111", month: 12, year: 2028 },
    });
    expect(matchHeldPlaceholderInBody(body, HELD)).toEqual({
      kind: "not_held",
    });
    expect(matchHeldPlaceholderInBody(body, FOREIGN)).toEqual({
      kind: "match",
      injectionRef: "inj_foreign",
    });
  });

  it("returns not_held for an empty body and for digits that are not a card", () => {
    expect(matchHeldPlaceholderInBody("", HELD)).toEqual({ kind: "not_held" });
    expect(matchHeldPlaceholderInBody('{"order":12345}', HELD)).toEqual({
      kind: "not_held",
    });
  });

  it("still sees the placeholder when more digits follow it", () => {
    expect(matchHeldPlaceholderInBody("4242 4242 4242 4242 999", HELD)).toEqual(
      { kind: "match", injectionRef: "inj_test" },
    );
  });
});

describe("textContainsForeignCard", () => {
  it("flags a different Luhn card and ignores the held number", () => {
    expect(textContainsForeignCard("4111111111111111", HELD.number)).toBe(true);
    expect(textContainsForeignCard(HELD.number, HELD.number)).toBe(false);
    expect(textContainsForeignCard(HELD.number, "4242 4242 4242 4242")).toBe(
      false,
    );
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
