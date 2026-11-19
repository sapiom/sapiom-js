import { supportedCReq } from "./three-d-secure";

const message = {
  messageType: "CReq",
  messageVersion: "2.2.0",
  challengeWindowSize: "05",
  acsTransID: "11111111-1111-1111-1111-111111111111",
  threeDSServerTransID: "22222222-2222-2222-2222-222222222222",
};
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

describe("supportedCReq", () => {
  it.each(["2.1.0", "2.2.0"])(
    "accepts supported %s messages",
    (messageVersion) => {
      expect(supportedCReq(encode({ ...message, messageVersion }))).toBe(true);
    },
  );
  it.each([
    { messageType: "CRes" },
    { messageVersion: "2.3.1" },
    { challengeWindowSize: "06" },
    { acsTransID: "invalid" },
    { threeDSServerTransID: null },
    { extra: true },
  ])("rejects unsupported fields %j", (change) => {
    expect(supportedCReq(encode({ ...message, ...change }))).toBe(false);
  });
  it.each(["", "%%%", "a", "e30=", "bnVsbA", "W10", "eyJ", "e30==="])(
    "rejects malformed encoding %s",
    (input) => {
      expect(supportedCReq(input)).toBe(false);
    },
  );
});
