import { getHeader, hasHeader, removeHeader, setHeader } from "./utils";

describe("Header Utilities", () => {
  describe("getHeader", () => {
    it("should find header with exact case match", () => {
      const headers = { "Content-Type": "application/json" };
      expect(getHeader(headers, "Content-Type")).toBe("application/json");
    });

    it("should find header with different case", () => {
      const headers = { "content-type": "application/json" };
      expect(getHeader(headers, "Content-Type")).toBe("application/json");
      expect(getHeader(headers, "CONTENT-TYPE")).toBe("application/json");
      expect(getHeader(headers, "CoNtEnT-TyPe")).toBe("application/json");
    });

    it("should return undefined for missing header", () => {
      const headers = { "Content-Type": "application/json" };
      expect(getHeader(headers, "Authorization")).toBeUndefined();
    });

    it("should handle array values", () => {
      const headers = { "Set-Cookie": ["cookie1=value1", "cookie2=value2"] };
      expect(getHeader(headers as any, "Set-Cookie")).toBe("cookie1=value1");
    });

    it("should find X-Sapiom-Transaction-Id with any case", () => {
      expect(
        getHeader(
          { "X-Sapiom-Transaction-Id": "tx_123" },
          "x-sapiom-transaction-id",
        ),
      ).toBe("tx_123");
      expect(
        getHeader(
          { "x-sapiom-transaction-id": "tx_456" },
          "X-Sapiom-Transaction-Id",
        ),
      ).toBe("tx_456");
    });
  });

  describe("hasHeader", () => {
    it("should return true for existing header", () => {
      const headers = { "Content-Type": "application/json" };
      expect(hasHeader(headers, "content-type")).toBe(true);
      expect(hasHeader(headers, "CONTENT-TYPE")).toBe(true);
    });

    it("should return false for missing header", () => {
      const headers = { "Content-Type": "application/json" };
      expect(hasHeader(headers, "Authorization")).toBe(false);
    });
  });

  describe("setHeader", () => {
    it("should set header preserving case", () => {
      const headers = { "Content-Type": "text/plain" };
      const result = setHeader(headers, "Authorization", "Bearer token");

      expect(result["Authorization"]).toBe("Bearer token");
      expect(result["Content-Type"]).toBe("text/plain");
    });

    it("should replace existing header regardless of case", () => {
      const headers = { "content-type": "text/plain", Authorization: "old" };
      const result = setHeader(headers, "CONTENT-TYPE", "application/json");

      expect(result["CONTENT-TYPE"]).toBe("application/json");
      expect(result["content-type"]).toBeUndefined(); // Old case removed
      expect(result["Authorization"]).toBe("old"); // Other headers preserved
    });

    it("should remove all case variants when setting same header", () => {
      const headers = {
        "x-custom": "value1",
        "X-Custom": "value2",
        "X-CUSTOM": "value3",
        Other: "keep",
      };

      const result = setHeader(headers, "X-Custom", "final");

      // All case variants should be removed, only new one exists
      const customKeys = Object.keys(result).filter(
        (k) => k.toLowerCase() === "x-custom",
      );
      expect(customKeys).toHaveLength(1);
      expect(customKeys[0]).toBe("X-Custom");
      expect(result["X-Custom"]).toBe("final");
      expect(result["Other"]).toBe("keep");
    });
  });

  describe("removeHeader", () => {
    it("should remove header regardless of case", () => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: "Bearer token",
      };
      const result = removeHeader(headers, "content-type");

      expect(result["Content-Type"]).toBeUndefined();
      expect(result["Authorization"]).toBe("Bearer token");
    });

    it("should remove all case variants", () => {
      const headers = {
        "x-custom": "value1",
        "X-Custom": "value2",
        "Other-Header": "keep",
      };

      const result = removeHeader(headers, "X-CUSTOM");

      expect(result["x-custom"]).toBeUndefined();
      expect(result["X-Custom"]).toBeUndefined();
      expect(result["Other-Header"]).toBe("keep");
    });
  });

  describe("case-insensitive header scenarios", () => {
    it("should handle Axios-style normalized headers", () => {
      // Axios normalizes to lowercase
      const axiosHeaders = {
        "content-type": "application/json",
        "x-sapiom-transaction-id": "tx_123",
      };

      expect(getHeader(axiosHeaders, "X-Sapiom-Transaction-Id")).toBe("tx_123");
      expect(hasHeader(axiosHeaders, "Content-Type")).toBe(true);
    });

    it("should handle Fetch-style mixed case headers", () => {
      // Fetch may preserve original case
      const fetchHeaders = {
        "Content-Type": "application/json",
        "x-sapiom-transaction-id": "tx_456",
      };

      expect(getHeader(fetchHeaders, "content-type")).toBe("application/json");
      expect(getHeader(fetchHeaders, "X-Sapiom-Transaction-Id")).toBe("tx_456");
    });

    it("should handle Node HTTP headers (may vary)", () => {
      const nodeHeaders = {
        "X-Sapiom-Transaction-Id": "tx_789",
        "x-payment": "payload",
      };

      expect(getHeader(nodeHeaders, "x-sapiom-transaction-id")).toBe("tx_789");
      expect(getHeader(nodeHeaders, "X-Payment")).toBe("payload");
    });
  });
});
