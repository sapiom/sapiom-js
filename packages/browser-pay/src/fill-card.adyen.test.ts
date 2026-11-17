import { ADYEN_DOM_CLIENT_KEY_EXPRESSION } from "./detect";
import {
  fillCard,
  type CardToFill,
  type FrameLike,
  type LocatorLike,
  type PageLike,
} from "./fill-card";
import type { AdyenGate, AdyenReadiness } from "./interceptor";

const CARD: CardToFill = {
  number: "4000000000000002",
  expMonth: 3,
  expYear: 2029,
  cvc: "321",
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
}

function fakePage(
  frames: { url: string; hint?: string }[],
  domKey: string | null = null,
): FakePage {
  const touched: string[] = [];
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
      },
      pressSequentially: async (text) => {
        touched.push(`type ${hint}`);
        value = text;
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
