import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ADYEN_DOM_CLIENT_KEY_EXPRESSION } from "./detect";
import {
  fillCard,
  type CardToFill,
  type FrameLike,
  type LocatorLike,
  type PageLike,
} from "./fill-card";
import {
  attachInterceptor,
  type AdyenGate,
  type AdyenReadiness,
} from "./interceptor";
import { httpPaymentRelay } from "./relay";
import { startCdpStub } from "../test/cdp-stub";

const CARD: CardToFill = {
  number: "4778901234561927",
  expMonth: 3,
  expYear: 2029,
  cvc: "321",
  brand: "visa",
};

const PAGE = "https://shop.example/checkout";
const KEY = "test_FRAMEKEY123";
const DOM_KEY = "test_DOMKEY456";
const securedField = (key: string | null, field: string) =>
  `https://checkoutshopper-test.adyen.com/checkoutshopper/securedfields/${
    key ?? "x"
  }/6.4.1/securedFields.html?type=card&d=${field}`;

/** One visible input per frame, named the way Adyen's secured fields name theirs. */
function candidate(hint: string) {
  return {
    index: 0,
    tag: "input",
    type: "tel",
    autocomplete: "",
    hints: hint,
    ids: "",
    label: "",
    hit: true,
    reachable: false,
    maxLength: -1,
    placeholder: "",
  };
}

interface FakePage {
  page: PageLike;
  /** Every click, fill or keystroke sequence sent to any field. */
  touched: string[];
  /** The last value typed or filled into each field, by hint. */
  typed: Record<string, string>;
}

function fakePage(
  frames: { url: string; hint?: string }[],
  domKey: string | null = null,
): FakePage {
  const touched: string[] = [];
  const typed: Record<string, string> = {};
  const built: FrameLike[] = [];
  const main: FrameLike = makeFrame(PAGE, undefined);
  built.push(main);
  for (const frame of frames) built.push(makeFrame(frame.url, frame.hint));

  function makeFrame(url: string, hint: string | undefined): FrameLike {
    let value = "";
    const locator: LocatorLike = {
      nth: () => locator,
      click: async () => {
        touched.push(`click ${hint}`);
      },
      fill: async (text) => {
        if (text) touched.push(`fill ${hint}`);
        value = text;
        typed[hint ?? ""] = text;
      },
      pressSequentially: async (text) => {
        touched.push(`type ${hint}`);
        value = text;
        typed[hint ?? ""] = text;
      },
      press: async () => {},
      inputValue: async () => value,
      boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
      evaluate: async (fn) =>
        fn({
          validity: { valid: true },
          getAttribute: () => null,
          blur: () => {},
        }),
      selectOption: async () => [],
    };
    return {
      url: () => url,
      parentFrame: () => (url === PAGE ? null : main),
      frameElement: async () => ({ evaluate: async () => false as never }),
      locator: () => locator,
      evaluate: async <R>(expression: string): Promise<R> => {
        if (expression === ADYEN_DOM_CLIENT_KEY_EXPRESSION) {
          return (url === PAGE ? domKey : null) as R;
        }
        if (expression.includes("innerWidth") && !expression.includes("=>")) {
          return { w: 1000, h: 800 } as R;
        }
        return {
          title: "",
          fields: hint ? [candidate(hint)] : [],
        } as R;
      },
    };
  }

  return {
    page: { frames: () => built, waitForTimeout: async () => {} },
    touched,
    typed,
  };
}

const ADYEN_FIELDS = (key: string | null) => [
  {
    url: securedField(key, "encryptedCardNumber"),
    hint: "encryptedcardnumber",
  },
  {
    url: securedField(key, "encryptedExpiryDate"),
    hint: "encryptedexpirydate",
  },
  {
    url: securedField(key, "encryptedSecurityCode"),
    hint: "encryptedsecuritycode",
  },
];

function gate(answer: AdyenReadiness | Error): AdyenGate & {
  calls: { clientKey: string; pageOrigin: string }[];
} {
  const calls: { clientKey: string; pageOrigin: string }[] = [];
  return {
    calls,
    async prepareAdyen(input) {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const NOT_TYPED = {
  ok: false,
  filled: [],
  missing: ["number", "expiry", "cvc"],
  unconfirmed: [],
  origins: {},
  untrusted: [],
};

describe("fillCard on Adyen secured fields", () => {
  it("types nothing without a gate: Adyen is off by default", async () => {
    const { page, touched } = fakePage(ADYEN_FIELDS(KEY));
    const result = await fillCard(page, CARD, { timeoutMs: 50 });
    expect(result).toStrictEqual({
      ...NOT_TYPED,
      blocked: "adyen_not_enabled",
    });
    expect(touched).toStrictEqual([]);
  });

  it("types nothing when the backend says Adyen encryption is not enabled", async () => {
    const { page, touched } = fakePage(ADYEN_FIELDS(KEY));
    const adyen = gate({ enabled: false, reason: "adyen_not_enabled" });
    const result = await fillCard(page, CARD, { timeoutMs: 50, adyen });
    expect(result).toStrictEqual({
      ...NOT_TYPED,
      blocked: "adyen_not_enabled",
    });
    expect(adyen.calls).toStrictEqual([
      { clientKey: KEY, pageOrigin: "https://shop.example" },
    ]);
    expect(touched).toStrictEqual([]);
  });

  it.each([
    ["visa", "4111111111111111"],
    ["mastercard", "5555444433331111"],
    ["american-express", "370000000000002"],
  ])(
    "types Adyen's plain %s test card, not the placeholder number",
    async (brand, standIn) => {
      const { page, typed } = fakePage(ADYEN_FIELDS(KEY));
      const result = await fillCard(
        page,
        { ...CARD, brand },
        { timeoutMs: 50, keyDelayMs: 0, adyen: gate({ enabled: true }) },
      );
      expect(result.ok).toBe(true);
      expect(typed.encryptedcardnumber).toBe(standIn);
    },
  );

  it("types nothing, without asking the backend, when the card's brand has no stand-in", async () => {
    for (const brand of [undefined, "discover", "unknown", "toString"]) {
      const { page, touched } = fakePage(ADYEN_FIELDS(KEY));
      const adyen = gate({ enabled: true });
      const result = await fillCard(
        page,
        { ...CARD, brand },
        { timeoutMs: 50, adyen },
      );
      expect(result).toStrictEqual({
        ...NOT_TYPED,
        blocked: "adyen_card_brand",
      });
      expect(adyen.calls).toHaveLength(0);
      expect(touched).toStrictEqual([]);
    }
  });

  it("types the stand-in when the backend will re-encrypt the card", async () => {
    const { page, touched } = fakePage(ADYEN_FIELDS(KEY));
    const adyen = gate({ enabled: true });
    const result = await fillCard(page, CARD, {
      timeoutMs: 50,
      keyDelayMs: 0,
      adyen,
    });
    expect(result).toMatchObject({
      ok: true,
      filled: ["number", "expiry", "cvc"],
    });
    expect(result.blocked).toBeUndefined();
    expect(touched).toContain("type encryptedcardnumber");
    expect(adyen.calls).toHaveLength(1);
  });

  it("reads the key from the page's config when the frame URLs carry none", async () => {
    const { page } = fakePage(ADYEN_FIELDS(null), DOM_KEY);
    const adyen = gate({ enabled: false, reason: "adyen_not_enabled" });
    await fillCard(page, CARD, { timeoutMs: 50, adyen });
    expect(adyen.calls).toStrictEqual([
      { clientKey: DOM_KEY, pageOrigin: "https://shop.example" },
    ]);
  });

  it("stops on two different keys, or none, without asking the backend", async () => {
    for (const frames of [
      [
        ...ADYEN_FIELDS(KEY).slice(0, 2),
        {
          url: securedField("test_OTHERKEY789", "encryptedSecurityCode"),
          hint: "encryptedsecuritycode",
        },
      ],
      ADYEN_FIELDS(null),
    ]) {
      const { page, touched } = fakePage(frames);
      const adyen = gate({ enabled: true });
      const result = await fillCard(page, CARD, { timeoutMs: 50, adyen });
      expect(result.blocked).toBe("adyen_client_key");
      expect(adyen.calls).toHaveLength(0);
      expect(touched).toStrictEqual([]);
    }
  });

  it("stops when the gate itself fails", async () => {
    const { page, touched } = fakePage(ADYEN_FIELDS(KEY));
    const result = await fillCard(page, CARD, {
      timeoutMs: 50,
      adyen: gate(new Error("boom")),
    });
    expect(result.blocked).toBe("adyen_encrypt");
    expect(touched).toStrictEqual([]);
  });

  it("types the card's own number into a number field outside Adyen's frames", async () => {
    const { page, typed } = fakePage([
      { url: securedField(KEY, "encryptedCardNumber") },
      { url: "https://js.stripe.com/v3/elements", hint: "cardnumber" },
      { url: "https://js.stripe.com/v3/exp", hint: "exp-date" },
      { url: "https://js.stripe.com/v3/cvc", hint: "cvc" },
    ]);
    const result = await fillCard(page, CARD, {
      timeoutMs: 50,
      keyDelayMs: 0,
      adyen: gate({ enabled: true }),
    });
    expect(result.ok).toBe(true);
    expect(typed.cardnumber).toBe(CARD.number);
  });

  it("never asks the gate on a page without Adyen secured fields", async () => {
    const { page } = fakePage([
      { url: "https://js.stripe.com/v3/elements", hint: "cardnumber" },
      { url: "https://js.stripe.com/v3/exp", hint: "exp-date" },
      { url: "https://js.stripe.com/v3/cvc", hint: "cvc" },
    ]);
    const adyen = gate({ enabled: false, reason: "adyen_not_enabled" });
    const result = await fillCard(page, CARD, {
      timeoutMs: 50,
      keyDelayMs: 0,
      adyen,
    });
    expect(result.ok).toBe(true);
    expect(result.blocked).toBeUndefined();
    expect(adyen.calls).toHaveLength(0);
  });
});

describe("fillCard against the backend's not-enabled answer, through the real relay", () => {
  /** The backend's body, verbatim: `adyen-encrypt.controller.ts` upper-cases the code. */
  const BACKEND_BODY = readFileSync(
    join(__dirname, "../test/fixtures/adyen-encrypt-not-enabled.409.json"),
    "utf8",
  );

  it.each([
    ["the backend's 409 body", 409, BACKEND_BODY],
    ["a lowercase code", 409, '{"code":"adyen_encryption_not_enabled"}'],
  ])(
    "blocks with adyen_not_enabled and types nothing on %s",
    async (_name, status, body) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const stub = await startCdpStub();
      const handle = await attachInterceptor(stub.url, {
        relay: httpPaymentRelay({
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          apiKey: "test-key",
          transactionId: "tx_adyen",
        }),
        placeholder: { number: CARD.number, injectionRef: "inj_adyen" },
      });
      try {
        const { page, touched } = fakePage(ADYEN_FIELDS(KEY));
        const result = await fillCard(page, CARD, {
          timeoutMs: 50,
          adyen: handle,
        });
        expect(result).toStrictEqual({
          ...NOT_TYPED,
          blocked: "adyen_not_enabled",
        });
        expect(touched).toStrictEqual([]);
      } finally {
        await handle.detach();
        await stub.close();
        server.close();
      }
    },
  );
});
