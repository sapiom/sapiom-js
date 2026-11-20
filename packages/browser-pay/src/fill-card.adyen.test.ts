import {
  fillCard,
  type CardToFill,
  type FrameLike,
  type LocatorLike,
  type PageLike,
} from "./fill-card";

const CARD: CardToFill = {
  number: "4778901234561927",
  expMonth: 3,
  expYear: 2029,
  cvc: "321",
};

const PAGE = "https://shop.example/checkout";
const securedField = (field: string) =>
  `https://checkoutshopper-test.adyen.com/checkoutshopper/securedfields/test_FRAMEKEY123/6.4.1/securedFields.html?type=card&d=${field}`;

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

function fakePage(frames: { url: string; hint?: string }[]): FakePage {
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

const ADYEN_FIELDS = [
  {
    url: securedField("encryptedCardNumber"),
    hint: "encryptedcardnumber",
  },
  {
    url: securedField("encryptedExpiryDate"),
    hint: "encryptedexpirydate",
  },
  {
    url: securedField("encryptedSecurityCode"),
    hint: "encryptedsecuritycode",
  },
];

// The page encrypts whatever is typed; the relay swaps those blobs for the
// real card's, so the placeholder is typed as on any other card form.
describe("fillCard on Adyen secured fields", () => {
  it("types the placeholder card into the secured-field frames", async () => {
    const { page, typed } = fakePage(ADYEN_FIELDS);
    const result = await fillCard(page, CARD, { timeoutMs: 50, keyDelayMs: 0 });

    expect(result.ok).toBe(true);
    expect(result.untrusted).toStrictEqual([]);
    expect(typed.encryptedcardnumber).toBe(CARD.number);
    expect(typed.encryptedsecuritycode).toBe(CARD.cvc);
    expect(typed.encryptedexpirydate?.replace(/\D/g, "")).toBe("0329");
  });
});
