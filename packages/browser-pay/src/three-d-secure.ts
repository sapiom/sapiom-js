/** The CReq subset accepted by the existing verification transport. */
export const supportedCReq = (encoded: string) => {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) return false;
  const unpadded = encoded.replace(/=+$/, "");
  const decoded = Buffer.from(encoded, "base64url");
  if (
    decoded.toString("base64url") !== unpadded ||
    (encoded !== unpadded && encoded.length % 4 !== 0)
  )
    return false;
  let message;
  try {
    message = JSON.parse(decoded.toString("utf8"));
  } catch {
    return false;
  }
  if (!message || typeof message !== "object" || Array.isArray(message))
    return false;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return (
    Object.keys(message).sort().join(",") ===
      "acsTransID,challengeWindowSize,messageType,messageVersion,threeDSServerTransID" &&
    message.messageType === "CReq" &&
    ["2.1.0", "2.2.0"].includes(message.messageVersion) &&
    ["01", "02", "03", "04", "05"].includes(message.challengeWindowSize) &&
    typeof message.acsTransID === "string" &&
    typeof message.threeDSServerTransID === "string" &&
    uuid.test(message.acsTransID) &&
    uuid.test(message.threeDSServerTransID)
  );
};
