import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";

import {
  ADYEN_BLOB_BINDING,
  adyenBlobWatchScript,
  hashObservedBlob,
} from "./adyen-blobs";

describe("Adyen blob watcher intrinsics", () => {
  it.each([
    [
      "JSON.parse",
      `const original = JSON.parse;
       JSON.parse = (text) => {
         const data = original(text);
         data.encryptedCardNumber[0].blob = "eyJ.PAGE_SELECTED";
         return data;
       };`,
    ],
    [
      "JSON.stringify",
      `JSON.stringify = () => '{"field":"encryptedCardNumber","blob":"eyJ.PAGE_SELECTED"}';`,
    ],
    ["Array.isArray", "Array.isArray = () => false;"],
    ["Set.prototype.has", "Set.prototype.has = () => false;"],
    [
      "Array.prototype iterator",
      `Array.prototype[Symbol.iterator] = function* () {
         yield { encryptedFieldName: "encryptedCardNumber", blob: "eyJ.PAGE_SELECTED" };
       };`,
    ],
    [
      "Object.prototype.toJSON",
      `Object.prototype.toJSON = () => ({ field: "encryptedCardNumber", blob: "eyJ.PAGE_SELECTED" });`,
    ],
  ])(
    "keeps the observed blob after the page replaces %s",
    (_name, override) => {
      const payloads: string[] = [];
      let listener: (event: unknown) => void = () => {};
      const page = createContext({
        [ADYEN_BLOB_BINDING]: (payload: string) => payloads.push(payload),
        addEventListener: (
          name: string,
          callback: (event: unknown) => void,
        ) => {
          if (name === "message") listener = callback;
        },
      });
      runInContext(adyenBlobWatchScript(), page);
      runInContext(override, page);
      const blob = "eyJ.SECURED_FIELD_TEST";
      const data = JSON.stringify({
        action: "encryption",
        fieldType: "encryptedCardNumber",
        encryptedCardNumber: [
          { encryptedFieldName: "encryptedCardNumber", blob },
        ],
      });
      const event = {
        isTrusted: true,
        origin: "https://checkoutshopper-test.adyen.com",
        data,
      };
      listener(event);
      listener({ ...event, isTrusted: false });
      listener({ ...event, origin: "https://untrusted.example" });

      expect(payloads).toHaveLength(1);
      expect(hashObservedBlob(payloads[0])).toEqual({
        field: "encryptedCardNumber",
        hash: createHash("sha256").update(blob).digest("hex"),
      });
      expect(
        runInContext(
          `typeof globalThis[${JSON.stringify(ADYEN_BLOB_BINDING)}]`,
          page,
        ),
      ).toBe("undefined");
    },
  );
});
